/**
 * 数据库适配器接口：封装 PostgreSQL 连接池
 *
 * 事务隔离关键：
 * - 全应用共享同一个 PostgresAdapter 实例（连接池）。
 * - 旧实现把 transactionClient 挂在实例字段上：并发 BEGIN 会互相覆盖连接，
 *   典型后果是 A 事务 INSERT parent 未提交时，B 的 INSERT child 跑到无事务连接 /
 *   错误连接上，触发 asset_components_package_id_fkey 一类外键失败。
 * - 正确做法：用 AsyncLocalStorage.run 把 PoolClient 绑定到「当前异步调用链」，
 *   并通过 transaction(fn) 回调 API 使用（BEGIN/COMMIT 不可再经 query 手工跨 await）。
 */

import { AsyncLocalStorage } from "node:async_hooks";

export interface QueryResult<T = any> {
  rows: T[];
  rowCount: number;
}

export interface DatabaseAdapter {
  query<T = any>(sql: string, params?: any[]): Promise<QueryResult<T>>;
  /** 执行多语句 SQL（如 migrate 脚本），不带参数 */
  exec(sql: string): Promise<void>;
  /**
   * 在独立连接上执行事务。回调内的 query/exec 自动绑定到该连接；
   * 成功 COMMIT，抛错 ROLLBACK。禁止在回调内再调 transaction/BEGIN。
   */
  transaction<T>(fn: () => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

interface TxContext {
  client: import("pg").PoolClient;
}

const txStorage = new AsyncLocalStorage<TxContext>();

/**
 * PostgreSQL 连接池适配器
 */
export class PostgresAdapter implements DatabaseAdapter {
  constructor(
    private pool: import("pg").Pool,
    private schema: string,
  ) {}

  async query<T = any>(sql: string, params?: any[]): Promise<QueryResult<T>> {
    const command = sql.trim().toUpperCase();
    if (command === "BEGIN" || command === "COMMIT" || command === "ROLLBACK") {
      throw new Error(
        `${command} via query() is not supported. Use adapter.transaction(async () => { ... }) so each async chain owns its connection.`,
      );
    }

    const prefixedSql = this.prefixSchema(sql);
    const tx = txStorage.getStore();
    if (tx) {
      const result = await tx.client.query(prefixedSql, params);
      return { rows: result.rows as T[], rowCount: result.rowCount ?? 0 };
    }

    const client = await this.pool.connect();
    try {
      await this.setSearchPath(client);
      const result = await client.query(prefixedSql, params);
      return {
        rows: result.rows as T[],
        rowCount: result.rowCount ?? 0,
      };
    } finally {
      client.release();
    }
  }

  async exec(sql: string): Promise<void> {
    const tx = txStorage.getStore();
    if (tx) {
      await tx.client.query(this.prefixSchema(sql));
      return;
    }
    const client = await this.pool.connect();
    try {
      await this.setSearchPath(client);
      await client.query(this.prefixSchema(sql));
    } finally {
      client.release();
    }
  }

  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    if (txStorage.getStore()) {
      throw new Error("Nested transaction() is not supported on PostgresAdapter");
    }
    const client = await this.pool.connect();
    await this.setSearchPath(client);
    try {
      return await txStorage.run({ client }, async () => {
        await client.query("BEGIN");
        try {
          const value = await fn();
          await client.query("COMMIT");
          return value;
        } catch (error) {
          try {
            await client.query("ROLLBACK");
          } catch {
            // ignore rollback errors; rethrow original
          }
          throw error;
        }
      });
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private prefixSchema(sql: string): string {
    if (this.schema === "public") return sql;
    return sql.replace(/\$\{p\}/g, `"${this.schema}".`);
  }

  private async setSearchPath(client: import("pg").PoolClient): Promise<void> {
    if (this.schema !== "public") {
      await client.query(`SET search_path TO "${this.schema}"`);
    }
  }
}

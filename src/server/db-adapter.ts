/**
 * 数据库适配器接口：封装 PostgreSQL 连接池
 */

export interface QueryResult<T = any> {
  rows: T[];
  rowCount: number;
}

export interface DatabaseAdapter {
  query<T = any>(sql: string, params?: any[]): Promise<QueryResult<T>>;
  /** 执行多语句 SQL（如 migrate 脚本），不带参数 */
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
}

/**
 * PostgreSQL 连接池适配器
 */
export class PostgresAdapter implements DatabaseAdapter {
  private transactionClient: import("pg").PoolClient | null = null;

  constructor(private pool: import("pg").Pool, private schema: string) {}

  async query<T = any>(sql: string, params?: any[]): Promise<QueryResult<T>> {
    const prefixedSql = this.prefixSchema(sql);
    const transactionCommand = sql.trim().toUpperCase();

    if (transactionCommand === "BEGIN") {
      this.transactionClient = await this.pool.connect();
      await this.setSearchPath(this.transactionClient);
      const result = await this.transactionClient.query(prefixedSql, params);
      return { rows: result.rows as T[], rowCount: result.rowCount ?? 0 };
    }

    if (this.transactionClient) {
      try {
        const result = await this.transactionClient.query(prefixedSql, params);
        return { rows: result.rows as T[], rowCount: result.rowCount ?? 0 };
      } finally {
        if (transactionCommand === "COMMIT" || transactionCommand === "ROLLBACK") {
          this.transactionClient.release();
          this.transactionClient = null;
        }
      }
    }

    const client = await this.pool.connect();
    try {
      await this.setSearchPath(client);
      const result = await client.query(prefixedSql, params);
      return {
        rows: result.rows as T[],
        rowCount: result.rowCount ?? 0
      };
    } finally {
      client.release();
    }
  }

  async exec(sql: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await this.setSearchPath(client);
      await client.query(this.prefixSchema(sql));
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    if (this.transactionClient) {
      this.transactionClient.release();
      this.transactionClient = null;
    }
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

/**
 * 数据库适配器接口：抽象 PostgreSQL 和 PGlite 的查询差异
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
  constructor(private pool: import("pg").Pool, private schema: string) {}

  async query<T = any>(sql: string, params?: any[]): Promise<QueryResult<T>> {
    const prefixedSql = this.prefixSchema(sql);
    const result = await this.pool.query(prefixedSql, params);
    return {
      rows: result.rows as T[],
      rowCount: result.rowCount ?? 0
    };
  }

  async exec(sql: string): Promise<void> {
    await this.pool.query(this.prefixSchema(sql));
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private prefixSchema(sql: string): string {
    if (this.schema === "public") return sql;
    return sql.replace(/\$\{p\}/g, `"${this.schema}".`);
  }
}

/**
 * PGlite 嵌入式适配器
 */
export class PGliteAdapter implements DatabaseAdapter {
  constructor(private db: import("@electric-sql/pglite").PGlite) {}

  async query<T = any>(sql: string, params?: any[]): Promise<QueryResult<T>> {
    const result = await this.db.query(sql, params);
    return {
      rows: result.rows as T[],
      rowCount: result.rows.length
    };
  }

  async exec(sql: string): Promise<void> {
    await this.db.exec(sql);
  }

  async close(): Promise<void> {
    await this.db.close();
  }
}

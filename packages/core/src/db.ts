/** A typed query layer over `node:sqlite`.
 *
 *  Hand-written rather than imported: storage is `DatabaseSync`, for which the query
 *  builders on npm ship no dialect. This is the dialect — it compiles a query to the SQL
 *  text and the bound parameters `DatabaseSync` wants, and nothing else runs it.
 *
 *  What it buys: a column name that is not in the table, or a value of the wrong type for
 *  the column it is compared to, is a typecheck failure rather than a runtime `SQLITE_ERROR`
 *  on a path a test did not walk. Every identifier reaching the SQL text comes from a
 *  declared table; every value reaching it is a parameter. */

import type { DatabaseSync } from "node:sqlite";

/** What SQLite stores and what a bound parameter may be. */
export type Value = string | number | null;

/** A table's name and its columns, with the row shape it yields. The columns are here so
 *  the layer can spell a default `SELECT` and so a test can hold this list against
 *  `PRAGMA table_info` — two copies of a schema with no check between them is the defect. */
export interface TableDef<Row> {
  readonly name: string;
  readonly columns: readonly (keyof Row & string)[];
}

export const table = <Row>(name: string, columns: readonly (keyof Row & string)[]): TableDef<Row> => ({
  name,
  columns,
});

/** A compiled query: the text, and the parameters in the order the text binds them. */
export interface Compiled {
  readonly sql: string;
  readonly params: readonly Value[];
}

export interface RunResult {
  /** Rows the statement wrote. Zero is how a guarded UPDATE says the guard did not match. */
  readonly changes: number;
}

export type Op = "=" | "!=" | "<" | "<=" | ">" | ">=";

/** A reference to the row that lost an upsert, for `ON CONFLICT … DO UPDATE SET`. */
class ExcludedRef {
  constructor(readonly column: string) {}
}

export const excluded = <Row>(column: keyof Row & string): ExcludedRef => new ExcludedRef(column);

/** What may be assigned to a column: a value of its own type, or the excluded row's. */
export type Setters<Row> = { readonly [K in keyof Row]?: Row[K] | ExcludedRef };

interface Cond {
  readonly column: string;
  readonly op: Op;
  readonly value: Value;
}

const quote = (name: string): string => `"${name.replace(/"/g, '""')}"`;

/** `= NULL` is never true in SQL, and a caller writing it means `IS NULL` every time. The
 *  dialect spells the SQLite the caller meant rather than compiling a query that silently
 *  matches nothing. */
function where(conds: readonly Cond[], params: Value[]): string {
  if (conds.length === 0) return "";
  const parts = conds.map((c) => {
    if (c.value === null) {
      if (c.op === "=") return `${quote(c.column)} IS NULL`;
      if (c.op === "!=") return `${quote(c.column)} IS NOT NULL`;
      throw new Error(`${c.column} ${c.op} NULL is never true; use = or != with null`);
    }
    params.push(c.value);
    return `${quote(c.column)} ${c.op} ?`;
  });
  return ` WHERE ${parts.join(" AND ")}`;
}

/** Assignments, plus the parameters they bind. Shared by UPDATE and by upsert. */
function assignments<Row>(set: Setters<Row>, params: Value[]): string[] {
  return Object.entries(set).map(([column, value]) => {
    if (value instanceof ExcludedRef) return `${quote(column)} = excluded.${quote(value.column)}`;
    params.push(value as Value);
    return `${quote(column)} = ?`;
  });
}

abstract class Query {
  protected constructor(protected readonly db: DatabaseSync) {}
  abstract compile(): Compiled;
  protected exec(): RunResult {
    const { sql, params } = this.compile();
    return { changes: Number(this.db.prepare(sql).run(...params).changes) };
  }
}

export class SelectQuery<Row, K extends keyof Row & string> extends Query {
  constructor(
    db: DatabaseSync,
    private readonly from: TableDef<Row>,
    private readonly cols: readonly K[],
    private readonly conds: readonly Cond[],
  ) {
    super(db);
  }

  /** Narrow to the columns asked for; the row type narrows with them. */
  select<J extends keyof Row & string>(cols: readonly J[]): SelectQuery<Row, J> {
    return new SelectQuery(this.db, this.from, cols, this.conds);
  }

  where<C extends keyof Row & string>(column: C, op: Op, value: Row[C] & Value): SelectQuery<Row, K> {
    return new SelectQuery(this.db, this.from, this.cols, [...this.conds, { column, op, value }]);
  }

  override compile(): Compiled {
    const params: Value[] = [];
    const cols = this.cols.map(quote).join(", ");
    return { sql: `SELECT ${cols} FROM ${quote(this.from.name)}${where(this.conds, params)}`, params };
  }

  /** The first matching row, or null. Null is "no such row", never a row of nulls. */
  get(): Pick<Row, K> | null {
    const { sql, params } = this.compile();
    const row = this.db.prepare(sql).get(...params);
    return row === undefined ? null : (row as Pick<Row, K>);
  }

  all(): Pick<Row, K>[] {
    const { sql, params } = this.compile();
    return this.db.prepare(sql).all(...params) as Pick<Row, K>[];
  }
}

export class InsertQuery<Row> extends Query {
  constructor(
    db: DatabaseSync,
    private readonly into: TableDef<Row>,
    private readonly row: Row,
    private readonly conflict: { readonly on: readonly (keyof Row & string)[]; readonly set: Setters<Row> } | null,
  ) {
    super(db);
  }

  /** On a clash with `on`, write `set` over the row that is already there. */
  onConflict(on: readonly (keyof Row & string)[], set: Setters<Row>): InsertQuery<Row> {
    return new InsertQuery(this.db, this.into, this.row, { on, set });
  }

  override compile(): Compiled {
    const params: Value[] = [];
    const cols = Object.keys(this.row as object);
    for (const col of cols) params.push((this.row as Record<string, Value>)[col] ?? null);
    let sql =
      `INSERT INTO ${quote(this.into.name)} (${cols.map(quote).join(", ")}) ` +
      `VALUES (${cols.map(() => "?").join(", ")})`;
    if (this.conflict !== null) {
      const set = assignments(this.conflict.set, params);
      sql += ` ON CONFLICT (${this.conflict.on.map(quote).join(", ")}) DO UPDATE SET ${set.join(", ")}`;
    }
    return { sql, params };
  }

  run(): RunResult {
    return this.exec();
  }
}

export class UpdateQuery<Row> extends Query {
  constructor(
    db: DatabaseSync,
    private readonly target: TableDef<Row>,
    private readonly sets: Setters<Row>,
    private readonly conds: readonly Cond[],
  ) {
    super(db);
  }

  set(sets: Setters<Row>): UpdateQuery<Row> {
    return new UpdateQuery(this.db, this.target, { ...this.sets, ...sets }, this.conds);
  }

  where<C extends keyof Row & string>(column: C, op: Op, value: Row[C] & Value): UpdateQuery<Row> {
    return new UpdateQuery(this.db, this.target, this.sets, [...this.conds, { column, op, value }]);
  }

  override compile(): Compiled {
    const params: Value[] = [];
    const sets = assignments(this.sets, params);
    if (sets.length === 0) throw new Error(`UPDATE ${this.target.name} sets nothing`);
    return { sql: `UPDATE ${quote(this.target.name)} SET ${sets.join(", ")}${where(this.conds, params)}`, params };
  }

  run(): RunResult {
    return this.exec();
  }
}

export class DeleteQuery<Row> extends Query {
  constructor(
    db: DatabaseSync,
    private readonly target: TableDef<Row>,
    private readonly conds: readonly Cond[],
  ) {
    super(db);
  }

  where<C extends keyof Row & string>(column: C, op: Op, value: Row[C] & Value): DeleteQuery<Row> {
    return new DeleteQuery(this.db, this.target, [...this.conds, { column, op, value }]);
  }

  override compile(): Compiled {
    const params: Value[] = [];
    return { sql: `DELETE FROM ${quote(this.target.name)}${where(this.conds, params)}`, params };
  }

  run(): RunResult {
    return this.exec();
  }
}

/** The entry point: a database, spoken to in tables rather than in strings. */
export class Dialect {
  constructor(private readonly db: DatabaseSync) {}

  selectFrom<Row>(from: TableDef<Row>): SelectQuery<Row, keyof Row & string> {
    return new SelectQuery(this.db, from, from.columns, []);
  }

  insertInto<Row>(into: TableDef<Row>, row: Row): InsertQuery<Row> {
    return new InsertQuery(this.db, into, row, null);
  }

  update<Row>(target: TableDef<Row>): UpdateQuery<Row> {
    return new UpdateQuery(this.db, target, {}, []);
  }

  deleteFrom<Row>(target: TableDef<Row>): DeleteQuery<Row> {
    return new DeleteQuery(this.db, target, []);
  }
}

/** One dialect per database, so callers that still pass a `DatabaseSync` around — every
 *  caller, for now — do not each build their own. */
const dialects = new WeakMap<DatabaseSync, Dialect>();

export function queries(db: DatabaseSync): Dialect {
  const known = dialects.get(db);
  if (known !== undefined) return known;
  const made = new Dialect(db);
  dialects.set(db, made);
  return made;
}

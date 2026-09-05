//! Reading and writing the plan.
//!
//! The database is the storage; [`wecode_core::Plan`] is the in-memory shape with
//! the structural rules. Loading builds a `Plan` and inserts through its own
//! validation, so a database that somehow held a cycle would be caught on read
//! rather than propagating.
//!
//! One module per reason to change, which is not one per table. Reading a plan back and
//! writing a row are different jobs over the same rows: the read path rebuilds the whole
//! validated graph out of every table at once, while each write touches one row and must
//! leave the rest of it alone.
//!
//! | | |
//! |---|---|
//! | `load` | `load_plan`, and the scope rows it reads — the whole graph, rebuilt and revalidated |
//! | `measure` | a `Measure` as rows and back, for the project table and the task table both |
//! | `project` | the `projects` row: written, filed away, asked about |
//! | `task` | the `tasks` row: created, erased, and amended one column at a time |
//! | `design` | which design a story was built on, and a digest of what it said |

mod design;
mod load;
mod measure;
mod project;
mod task;

#[cfg(test)]
mod fixtures;

pub use design::Design;

//! The intent tree: storage plus the structural rules that keep it coherent.
//!
//! Grammar violations are rejected on insert. Soft defects (a missing measure, a
//! vague statement) are *not* — those are reported by [`crate::Admission`] so the
//! creator can be asked. The split matters: a tree may hold drafts, but it may
//! never hold a cycle or a task parented to a vision.

use std::collections::BTreeMap;

use crate::id::IntentId;
use crate::intent::{Intent, IntentKind};

/// Structural rejections. These make the tree incoherent, so they are errors
/// rather than defects.
#[derive(Clone, PartialEq, Eq, Debug, thiserror::Error)]
pub enum TreeError {
    #[error("id is empty")]
    EmptyId,

    #[error("intent `{0}` already exists")]
    Duplicate(IntentId),

    #[error("parent `{0}` does not exist")]
    MissingParent(IntentId),

    #[error("a {child} may not be parented to a {parent}")]
    IllegalParentKind { child: IntentKind, parent: IntentKind },

    #[error("`{0}` would create a cycle")]
    Cycle(IntentId),

    #[error("`{0}` is not in the tree")]
    NotFound(IntentId),
}

/// An intent tree. Roots are intents with no parent.
#[derive(Clone, Default, Debug)]
pub struct IntentTree {
    nodes: BTreeMap<IntentId, Intent>,
}

impl IntentTree {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    #[must_use]
    pub fn len(&self) -> usize {
        self.nodes.len()
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.nodes.is_empty()
    }

    #[must_use]
    pub fn get(&self, id: &IntentId) -> Option<&Intent> {
        self.nodes.get(id)
    }

    pub fn iter(&self) -> impl Iterator<Item = &Intent> {
        self.nodes.values()
    }

    /// Inserts an intent, enforcing the structural grammar.
    pub fn insert(&mut self, intent: Intent) -> Result<(), TreeError> {
        if intent.id.is_empty() {
            return Err(TreeError::EmptyId);
        }
        if self.nodes.contains_key(&intent.id) {
            return Err(TreeError::Duplicate(intent.id.clone()));
        }
        if let Some(parent_id) = &intent.parent {
            let parent = self
                .nodes
                .get(parent_id)
                .ok_or_else(|| TreeError::MissingParent(parent_id.clone()))?;

            if !intent.kind.valid_parents().contains(&parent.kind) {
                return Err(TreeError::IllegalParentKind {
                    child: intent.kind,
                    parent: parent.kind,
                });
            }
            if *parent_id == intent.id || self.ancestors(parent_id).any(|a| a.id == intent.id) {
                return Err(TreeError::Cycle(intent.id.clone()));
            }
        }
        self.nodes.insert(intent.id.clone(), intent);
        Ok(())
    }

    /// Re-parents an intent, enforcing the same rules as insert.
    pub fn reparent(
        &mut self,
        id: &IntentId,
        new_parent: Option<IntentId>,
    ) -> Result<(), TreeError> {
        let kind = self.nodes.get(id).ok_or_else(|| TreeError::NotFound(id.clone()))?.kind;

        if let Some(pid) = &new_parent {
            let parent =
                self.nodes.get(pid).ok_or_else(|| TreeError::MissingParent(pid.clone()))?;
            if !kind.valid_parents().contains(&parent.kind) {
                return Err(TreeError::IllegalParentKind { child: kind, parent: parent.kind });
            }
            if pid == id || self.ancestors(pid).any(|a| a.id == *id) {
                return Err(TreeError::Cycle(id.clone()));
            }
        }
        // Unwrap is sound: presence was checked above and nothing removed it.
        self.nodes.get_mut(id).expect("checked present").parent = new_parent;
        Ok(())
    }

    /// Direct children, in id order.
    pub fn children(&self, id: &IntentId) -> impl Iterator<Item = &Intent> {
        self.nodes.values().filter(move |n| n.parent.as_ref() == Some(id))
    }

    /// Ancestors, nearest first. Stops at a root or a dangling parent.
    pub fn ancestors(&self, id: &IntentId) -> impl Iterator<Item = &Intent> {
        Ancestors { tree: self, next: self.nodes.get(id).and_then(|n| n.parent.clone()) }
    }

    /// Roots, in id order.
    pub fn roots(&self) -> impl Iterator<Item = &Intent> {
        self.nodes.values().filter(|n| n.parent.is_none())
    }

    /// Whether this intent reaches a root of the given kind — used to tell aligned
    /// work from orphan work.
    #[must_use]
    pub fn reaches_kind(&self, id: &IntentId, kind: IntentKind) -> bool {
        self.nodes.get(id).is_some_and(|n| n.kind == kind)
            || self.ancestors(id).any(|a| a.kind == kind)
    }
}

struct Ancestors<'t> {
    tree: &'t IntentTree,
    next: Option<IntentId>,
}

impl<'t> Iterator for Ancestors<'t> {
    type Item = &'t Intent;

    fn next(&mut self) -> Option<Self::Item> {
        let id = self.next.take()?;
        let node = self.tree.nodes.get(&id)?;
        self.next = node.parent.clone();
        Some(node)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::intent::{IntentKind, Link};

    fn tree() -> IntentTree {
        let mut t = IntentTree::new();
        t.insert(Intent::new("vis", IntentKind::Vision, "be the best")).unwrap();
        t.insert(
            Intent::new("goal", IntentKind::Goal, "cut latency").under("vis", Link::Requires),
        )
        .unwrap();
        t.insert(
            Intent::new("proj", IntentKind::Project, "speed up export")
                .under("goal", Link::Requires),
        )
        .unwrap();
        t
    }

    #[test]
    fn accepts_a_legal_chain() {
        let t = tree();
        assert_eq!(t.len(), 3);
        assert_eq!(t.roots().count(), 1);
    }

    #[test]
    fn rejects_illegal_parent_kind() {
        let mut t = tree();
        let err = t
            .insert(Intent::new("t", IntentKind::Task, "do it").under("goal", Link::Requires))
            .unwrap_err();
        assert!(matches!(err, TreeError::IllegalParentKind { .. }), "got {err:?}");
    }

    #[test]
    fn rejects_missing_parent() {
        let mut t = tree();
        let err = t
            .insert(Intent::new("t", IntentKind::Task, "do it").under("nope", Link::Requires))
            .unwrap_err();
        assert_eq!(err, TreeError::MissingParent(IntentId::new("nope")));
    }

    #[test]
    fn rejects_duplicates_and_empty_ids() {
        let mut t = tree();
        assert!(matches!(
            t.insert(Intent::new("goal", IntentKind::Goal, "again")).unwrap_err(),
            TreeError::Duplicate(_)
        ));
        assert_eq!(t.insert(Intent::new("---", IntentKind::Goal, "x")).unwrap_err(), TreeError::EmptyId);
    }

    #[test]
    fn ad_hoc_task_may_be_a_root() {
        let mut t = tree();
        t.insert(Intent::new("chore", IntentKind::Task, "bump deps")).unwrap();
        assert_eq!(t.roots().count(), 2);
    }

    #[test]
    fn ancestors_are_nearest_first() {
        let t = tree();
        let names: Vec<_> =
            t.ancestors(&IntentId::new("proj")).map(|a| a.id.to_string()).collect();
        assert_eq!(names, vec!["goal", "vis"]);
    }

    #[test]
    fn children_are_listed() {
        let t = tree();
        assert_eq!(t.children(&IntentId::new("vis")).count(), 1);
        assert_eq!(t.children(&IntentId::new("proj")).count(), 0);
    }

    #[test]
    fn reparent_rejects_cycles() {
        let mut t = tree();
        let err = t.reparent(&IntentId::new("vis"), Some(IntentId::new("proj"))).unwrap_err();
        // A vision cannot be parented at all, so kind check fires before the cycle check.
        assert!(matches!(err, TreeError::IllegalParentKind { .. }), "got {err:?}");

        // Project under its own descendant: build a task first, then try.
        t.insert(Intent::new("task", IntentKind::Task, "x").under("proj", Link::Requires))
            .unwrap();
        let err = t.reparent(&IntentId::new("proj"), Some(IntentId::new("proj"))).unwrap_err();
        assert!(matches!(err, TreeError::Cycle(_)), "got {err:?}");
    }

    #[test]
    fn reparent_moves_a_node() {
        let mut t = tree();
        t.insert(Intent::new("goal2", IntentKind::Goal, "other").under("vis", Link::Requires))
            .unwrap();
        t.reparent(&IntentId::new("proj"), Some(IntentId::new("goal2"))).unwrap();
        assert_eq!(t.children(&IntentId::new("goal2")).count(), 1);
        assert_eq!(t.children(&IntentId::new("goal")).count(), 0);
    }

    #[test]
    fn reaches_kind_walks_upward() {
        let t = tree();
        assert!(t.reaches_kind(&IntentId::new("proj"), IntentKind::Vision));
        let mut t2 = t.clone();
        t2.insert(Intent::new("orphan", IntentKind::Task, "x")).unwrap();
        assert!(!t2.reaches_kind(&IntentId::new("orphan"), IntentKind::Vision));
    }
}

# Change Log

All notable changes to the "tree-of-deductions" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [Unreleased]

- Renamed the concept and extension from "chain of deductions" to "tree of deductions": package name (`chainofdeductions` → `tree-of-deductions`), extension display name (`ChainOfDeductions` → `TreeOfDeductions`), command IDs (`chainofdeductions.*` → `treeofdeductions.*`), the edge store directory (`.chainofdeductions/` → `.treeofdeductions/`), and the design document filename (`chain-of-deductions.md` → `tree-of-deductions.md`). The rename reflects that the node-centric view of the deduction graph is a tree (each node spans a subtree), while the whole project remains a DAG.
- Renamed the concept and extension from "chain of inference" to "chain of deductions": extension ID and display name, command IDs (`chainofdeductions.*`), and the edge store directory (`.chainofinference/` → `.chainofdeductions/`).
- Initial release

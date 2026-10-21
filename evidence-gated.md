# Evidence-Gated Development

## 1. Purpose

This project extends an existing coding-agent workflow with an evidence layer.

The purpose is to make the reasoning behind a completed code change inspectable by humans without exposing or depending on the model's chain-of-thought.

A completed development task produces:

1. a code change set;
2. a design evidence package;
3. a code-style evidence package.

The evidence package is reviewed by a human before the change is accepted.

---

## 2. Core Model

A software project is understood as a directed acyclic graph of design knowledge and implementation.

### Nodes

Nodes are existing project artifacts that describe or implement design.

There are two important classes of nodes:

* **Design nodes** — non-leaf nodes, normally represented by documents such as `architecture.md`, API specifications, module-design documents, and similar artifacts.
* **Code nodes** — leaf nodes, represented by source-code files and other executable implementation artifacts.

Existing project artifacts remain the primary representation of the nodes. The evidence system does not require a separate database of design nodes.

### Edges

Edges are rationale relationships between nodes.

An edge states why the target design or implementation follows from the source design or knowledge.

Conceptually:

```text
Source Design
     │
     │ rationale
     ▼
Target Design
     │
     │ rationale
     ▼
Code
```

An edge is stored separately from the artifacts themselves.

---

## 3. Current Architecture

The current architecture is described by the project's existing design documents.

For this system, `architecture.md` is the primary current-state description.

It describes:

* the role of the Evidence-Gated Development system;
* the distinction between Design Evidence and Code Style Evidence;
* the relationship between Change Sets and Evidence Packages;
* the human review boundary.

The architecture document describes the current state. It does not attempt to contain the complete history of how the current design was derived.

---

## 4. Design Derivation

Design rationale is maintained separately from the current architecture description.

A rationale edge explains a transition from one design node to another.

A rationale may refer to:

* a problem or requirement;
* an observation about the existing system;
* constraints;
* alternatives considered;
* the decision made;
* consequences of the decision.

The rationale is not intended to reproduce model chain-of-thought.

It records the engineering reasoning necessary for another engineer to understand why the design relationship exists.

---

## 5. Design Evolution

Design changes are versioned together with the project through Git.

When a design changes:

1. the relevant design artifact changes;
2. the corresponding rationale edge is added or updated;
3. Git records the change.

Therefore:

* `architecture.md` represents the current architecture;
* rationale edges explain design derivation;
* Git records how both evolved over time.

The current software architecture knowledge is therefore a projection of the historical design evolution onto the current state.

---

## 6. Evidence-Gated Change Review

The basic unit of review is a **Change Set**, not an individual tool action.

A Change Set is the set of code modifications produced by one completed development task.

During normal development, the agent may freely inspect the repository, reason, edit files, and run tests.

After the task is complete, the system generates an Evidence Package for the resulting Change Set.

The Change Set is then reviewed together with its Evidence Package.

---

## 7. Evidence Package

Each Change Set must provide two evidence dimensions.

### 7.1 Design Evidence

Design Evidence explains why the Change Set is appropriate from the perspective of the project's design.

It may reference:

* current architecture documents;
* API and module specifications;
* relevant design rationale edges;
* relevant design evolution in Git;
* business requirements;
* existing implementation patterns where they establish architectural intent.

The central question is:

> Why is this Change Set consistent with, or a justified change to, the current design?

### 7.2 Code Style Evidence

Code Style Evidence explains why the implementation follows the project's accepted coding conventions.

It may reference:

* team or organization coding guidance;
* existing patterns in the repository;
* performance conventions;
* readability conventions;
* error-handling conventions;
* other established implementation practices.

The central question is:

> Given the intended design, why is this an appropriate way to implement it?

---

## 8. Human Review

The first version of the system uses human review rather than automatic evidence scoring.

The reviewer sees:

```text
Task
  ↓
Design Evidence
  ↓
Code Style Evidence
  ↓
Change Set
  ↓
Verification Results
```

The reviewer decides whether the evidence is sufficient to accept the Change Set.

The system does not initially assign a numerical credibility score to evidence.

The purpose of the first version is to expose the evidence and collect human judgments about what constitutes sufficient engineering evidence.

---

## 9. Implementation Boundary

The Evidence layer is orthogonal to the coding agent itself.

The existing agent may continue using its normal development loop.

The Evidence system intervenes at the task boundary:

```text
Agent Development
       ↓
Completed Change Set
       ↓
Evidence Package
       ↓
Human Review
       ↓
Accept / Reject
```

Future versions may introduce automatic evidence review, but the initial architecture does not depend on it.

---

## 10. Knowledge Model Summary

The project's software architecture knowledge consists of:

```text
Design Nodes
    +
Rationale Edges
    +
Code Implementations
    +
Git History
```

where:

* Design Nodes describe what the system is designed to be.
* Rationale Edges describe why one design follows from another.
* Code Nodes implement the resulting design.
* Git records the temporal evolution of all of the above.

The central architectural principle is:

> Design is maintained as an explicit, version-controlled engineering artifact, while design rationale is maintained as explicit edges connecting design and implementation artifacts.

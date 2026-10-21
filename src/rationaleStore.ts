import * as vscode from 'vscode';
import { TextDecoder } from 'util';
import * as path from 'path';

/** Folder (relative to the workspace root) holding the rationale edge store. */
export const RATIONALE_DIR = '.treeofdeductions';
export const RATIONALE_FILE = 'rationale.json';

export type EdgeSide = 'from' | 'to';

/** One endpoint of a rationale edge: a file plus a 1-based inclusive line range. */
export interface RationaleEndpoint {
    /** Workspace-relative path using '/' separators. */
    file: string;
    /** [start, end] line numbers, 1-based, inclusive. */
    lines: [number, number];
}

/** A rationale edge: `to` follows from `from` (see tree-of-deductions.md §2.1). */
export interface RationaleEdge {
    from: RationaleEndpoint;
    to: RationaleEndpoint;
    rationale: string;
}

/** A parsed edge plus the workspace folder its rationale file was found in. */
export interface StoredEdge extends RationaleEdge {
    /** Endpoint `file` paths resolve against this folder. */
    base: vscode.Uri;
}

export interface ParseResult {
    edges: RationaleEdge[];
    errors: string[];
    /** True when the document itself is unreadable; false when only individual edges were rejected. */
    fatal: boolean;
}

/** Parses a rationale document (`{"edges": [...]}`) into edges. */
export function parseRationaleDocument(text: string): ParseResult {
    let value: unknown;
    try {
        value = JSON.parse(text);
    } catch (error) {
        return { edges: [], errors: [`invalid JSON document: ${String(error)}`], fatal: true };
    }
    if (typeof value !== 'object' || value === null || !Array.isArray((value as Record<string, unknown>).edges)) {
        return { edges: [], errors: ['expected a top-level object with an "edges" array'], fatal: true };
    }
    const edges: RationaleEdge[] = [];
    const errors: string[] = [];
    (value as { edges: unknown[] }).edges.forEach((entry, index) => {
        const problem = validateEdge(entry);
        if (problem !== undefined) {
            errors.push(`edges[${index}]: ${problem}`);
            return;
        }
        edges.push(entry as RationaleEdge);
    });
    return { edges, errors, fatal: false };
}

function validateEdge(value: unknown): string | undefined {
    if (typeof value !== 'object' || value === null) {
        return 'expected an object';
    }
    const edge = value as Record<string, unknown>;
    for (const side of ['from', 'to'] as const) {
        const problem = validateEndpoint(edge[side], side);
        if (problem !== undefined) {
            return problem;
        }
    }
    if (typeof edge.rationale !== 'string' || edge.rationale.trim().length === 0) {
        return 'rationale must be a non-empty string';
    }
    return undefined;
}

function validateEndpoint(value: unknown, name: string): string | undefined {
    if (typeof value !== 'object' || value === null) {
        return `${name} must be an object`;
    }
    const endpoint = value as Record<string, unknown>;
    if (typeof endpoint.file !== 'string' || endpoint.file.length === 0) {
        return `${name}.file must be a non-empty string`;
    }
    const lines = endpoint.lines;
    if (
        !Array.isArray(lines) || lines.length !== 2 ||
        !Number.isInteger(lines[0]) || !Number.isInteger(lines[1]) ||
        lines[0] < 1 || lines[1] < lines[0]
    ) {
        return `${name}.lines must be two integers [start, end] with 1 <= start <= end (1-based, inclusive)`;
    }
    return undefined;
}

/** Loads `.treeofdeductions/rationale.json` and keeps it fresh via a file watcher. */
export class RationaleStore implements vscode.Disposable {
    private edges: StoredEdge[] = [];
    private readonly changeEmitter = new vscode.EventEmitter<void>();
    readonly onDidChange = this.changeEmitter.event;
    private watcher: vscode.FileSystemWatcher | undefined;

    /** Loads once and starts watching the rationale file in every workspace folder. */
    start(): void {
        void this.reload();
        this.watcher = vscode.workspace.createFileSystemWatcher(`**/${RATIONALE_DIR}/${RATIONALE_FILE}`);
        this.watcher.onDidChange(() => void this.reload());
        this.watcher.onDidCreate(() => void this.reload());
        this.watcher.onDidDelete(() => void this.reload());
    }

    async reload(): Promise<void> {
        const loaded: StoredEdge[] = [];
        // Search the whole workspace so a rationale file works no matter which
        // ancestor folder is open; endpoint `file` paths resolve against the
        // project root containing the `.treeofdeductions` directory.
        const files = await vscode.workspace.findFiles(`**/${RATIONALE_DIR}/${RATIONALE_FILE}`, '**/node_modules/**');
        for (const uri of files) {
            let text: string;
            try {
                text = new TextDecoder('utf-8').decode(await vscode.workspace.fs.readFile(uri));
            } catch {
                continue; // unreadable — nothing to load from this file
            }
            const { edges, errors, fatal } = parseRationaleDocument(text);
            if (fatal) {
                // Keep whatever was loaded before rather than blanking every lens over a typo mid-edit.
                console.warn(`[treeofdeductions] ${uri.fsPath}: ${errors.join('; ')} — keeping previously loaded edges`);
                return;
            }
            for (const message of errors) {
                console.warn(`[treeofdeductions] ${uri.fsPath}: ${message}`);
            }
            console.log(`[treeofdeductions] loaded ${edges.length} rationale edges from ${uri.fsPath}`);
            const base = vscode.Uri.joinPath(uri, '..', '..');
            loaded.push(...edges.map(edge => ({ ...edge, base })));
        }
        this.edges = loaded;
        this.reindex();
        this.changeEmitter.fire();
    }

    /** Number of currently loaded edges. */
    get edgeCount(): number {
        return this.edges.length;
    }

    /** Every loaded edge — the whole-project graph. */
    get allEdges(): readonly StoredEdge[] {
        return this.edges;
    }

    /** Endpoint file (resolved fsPath) to the edges touching it, per side. Rebuilt on every load. */
    private readonly edgesByFile = new Map<string, { from: StoredEdge[]; to: StoredEdge[] }>();

    private reindex(): void {
        this.edgesByFile.clear();
        for (const edge of this.edges) {
            for (const side of ['from', 'to'] as const) {
                const key = path.normalize(this.endpointUri(edge, side).fsPath);
                const entry = this.edgesByFile.get(key) ?? { from: [], to: [] };
                entry[side].push(edge);
                this.edgesByFile.set(key, entry);
            }
        }
    }

    /** All edges whose `to` endpoint lives in `uri` — everything pointing at that file. */
    incomingTo(uri: vscode.Uri): StoredEdge[] {
        return this.edgesIn(uri, 'to');
    }

    /** Edges whose `to` endpoint covers `position` in `uri`. */
    incomingAt(uri: vscode.Uri, position: vscode.Position): StoredEdge[] {
        return this.incomingTo(uri).filter(edge => {
            const [start, end] = edge.to.lines;
            return position.line >= start - 1 && position.line <= end - 1;
        });
    }

    endpointUri(edge: StoredEdge, side: EdgeSide): vscode.Uri {
        return vscode.Uri.file(path.resolve(edge.base.fsPath, edge[side].file));
    }

    /** The endpoint's range as a VS Code range, converted from 1-based inclusive lines. */
    endpointRange(edge: StoredEdge, side: EdgeSide): vscode.Range {
        const [start, end] = edge[side].lines;
        // End at column 0 of the line after `end` so the whole last line is covered.
        return new vscode.Range(start - 1, 0, end, 0);
    }

    /** All edges whose `side` endpoint lives in `uri` — the doc's other role, opposite of incoming. */
    edgesIn(uri: vscode.Uri, side: EdgeSide): StoredEdge[] {
        return this.edgesByFile.get(path.normalize(uri.fsPath))?.[side] ?? [];
    }

    dispose(): void {
        this.watcher?.dispose();
        this.changeEmitter.dispose();
    }
}

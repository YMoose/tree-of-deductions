import * as vscode from 'vscode';
import * as path from 'path';
import { EdgeSide, RationaleStore, StoredEdge } from './rationaleStore';

export const REVEAL_ENDPOINT_COMMAND = 'treeofdeductions.revealEndpoint';

/** Endpoint identity: base-relative file path + exact 1-based line range. */
function keyOf(edge: StoredEdge, side: EdgeSide): string {
    return `${edge[side].file}:${edge[side].lines[0]}-${edge[side].lines[1]}`;
}

const docCache = new Map<string, Promise<vscode.TextDocument | undefined>>();

/** First-line text of a range for Outline-style labels; '' when unreadable. */
async function rangeText(uri: vscode.Uri, line: number): Promise<string> {
    const key = uri.toString();
    let document = docCache.get(key);
    if (!document) {
        document = Promise.resolve(vscode.workspace.openTextDocument(uri)).catch(() => undefined);
        docCache.set(key, document);
    }
    const doc = await document;
    if (!doc) {
        return '';
    }
    return doc.lineAt(Math.min(line, doc.lineCount - 1)).text.trim();
}

function snippet(text: string, max: number): string {
    return text.length > max ? `${text.slice(0, max)}…` : text;
}

function revealCommand(uri: vscode.Uri, range: vscode.Range): vscode.Command {
    return { command: REVEAL_ENDPOINT_COMMAND, title: 'Reveal', arguments: [uri, range] };
}

/** Label with the explorer-filter highlight applied — marks entries in the active document. */
function highlightLabel(text: string, active: boolean): string | vscode.TreeItemLabel {
    return active ? { label: text, highlights: [[0, text.length]] } : text;
}

/** Icon tint for entries belonging to the active document. */
const ACTIVE_TINT = new vscode.ThemeColor('charts.blue');
/** Icon tint for the derivation path of the range under the cursor. */
const PATH_TINT = new vscode.ThemeColor('gitDecoration.addedResourceForeground');

/** Opens `uri` at `range`, selecting the first line — used by every tree item. */
export async function revealEndpoint(uri: vscode.Uri, range: vscode.Range): Promise<void> {
    const editor = await vscode.window.showTextDocument(uri, { preview: true });
    const revealed = range.end.line < editor.document.lineCount
        ? range
        : new vscode.Range(range.start, editor.document.lineAt(editor.document.lineCount - 1).range.end);
    editor.revealRange(revealed, vscode.TextEditorRevealType.InCenter);
    editor.selection = new vscode.Selection(revealed.start, revealed.start);
}

// ---------------------------------------------------------------------------
// Overview: the deduction chain rooted at the files holding its sources.
// ---------------------------------------------------------------------------

/** A file containing source propositions — the unit the overview roots at. */
export interface OverviewFile {
    kind: 'file';
    /** Base-relative path as used by edge endpoints. */
    file: string;
    ranges: OverviewRange[];
}

/** One anchored range in the graph; children are the edges leaving it. */
export interface OverviewRange {
    kind: 'range';
    /** Any edge touching this range on `side`, to derive uri/range from. */
    edge: StoredEdge;
    side: EdgeSide;
    key: string;
    text: string;
    edges: OverviewEdge[];
    /** What the node hangs under: its root file, or the edge deriving it. */
    parent?: OverviewFile | OverviewEdge;
}

/** One derivation step; its child is the target range. */
export interface OverviewEdge {
    kind: 'edge';
    edge: StoredEdge;
    child?: OverviewRange;
    /** The range this derivation departs from. */
    parent?: OverviewRange;
}

export type OverviewNode = OverviewFile | OverviewRange | OverviewEdge;

export class DeductionOverviewProvider implements vscode.TreeDataProvider<OverviewNode> {
    private readonly changeEmitter = new vscode.EventEmitter<OverviewNode | undefined>();
    readonly onDidChangeTreeData = this.changeEmitter.event;
    /** Status line for the view; empty when there is something to show. */
    message = '';

    /**
     * The rendered model. Node objects persist across rebuilds — the view tracks
     * expansion and reveal by object identity, so they are updated in place.
     */
    private files: OverviewFile[] = [];
    private readonly fileNodes = new Map<string, OverviewFile>();
    private readonly rangeNodes = new Map<string, OverviewRange>();
    private readonly edgeNodes = new Map<StoredEdge, OverviewEdge>();
    /** The chain node under the cursor, and its full derivation path up to the roots. */
    private cursorNode: OverviewRange | undefined;
    private cursorPath = new Set<OverviewNode>();

    constructor(private readonly store: RationaleStore) {
        store.onDidChange(() => void this.refresh());
        vscode.window.onDidChangeActiveTextEditor(() => void this.refresh());
        vscode.workspace.onDidChangeTextDocument(() => void this.refresh());
        vscode.window.onDidChangeTextEditorSelection(({ textEditor }) => {
            // Only the derivation path depends on the cursor; re-render only when it moved.
            if (textEditor === vscode.window.activeTextEditor && this.updateCursorPath()) {
                this.changeEmitter.fire(undefined);
            }
        });
    }

    /** Rebuilds the model. Highlight follows the active document; expansion stays with the user. */
    async refresh(): Promise<void> {
        this.message = this.store.edgeCount === 0 ? 'No rationale edges loaded' : '';
        this.files = [];
        if (this.store.edgeCount > 0) {
            await this.buildModel();
        }
        this.updateCursorPath();
        this.changeEmitter.fire(undefined);
    }

    /** Reconciles the whole (small) graph into node objects, creating or updating in place. */
    private async buildModel(): Promise<void> {
        const edges = this.store.allEdges;
        // Sources: ranges no edge points at. Reachable: sources plus everything derived from them.
        const targets = new Set(edges.map(edge => keyOf(edge, 'to')));
        const sources = new Set<string>();
        for (const edge of edges) {
            const key = keyOf(edge, 'from');
            if (!targets.has(key)) {
                sources.add(key);
            }
        }
        const reachable = new Set(sources);
        const queue = [...sources];
        while (queue.length > 0) {
            const key = queue.shift()!;
            for (const edge of edges) {
                if (keyOf(edge, 'from') === key) {
                    const to = keyOf(edge, 'to');
                    if (!reachable.has(to)) {
                        reachable.add(to);
                        queue.push(to);
                    }
                }
            }
        }
        // One node per reachable range; `edge`/`side` only derive its uri and label.
        const exposure = new Map<string, { edge: StoredEdge; side: EdgeSide }>();
        for (const edge of edges) {
            for (const side of ['from', 'to'] as const) {
                const key = keyOf(edge, side);
                if (reachable.has(key) && !exposure.has(key)) {
                    exposure.set(key, { edge, side });
                }
            }
        }
        const liveRanges = new Set<string>();
        for (const [key, { edge, side }] of exposure) {
            liveRanges.add(key);
            const node = this.rangeNodes.get(key) ?? { kind: 'range', edge, side, key, text: '', edges: [] };
            node.edge = edge;
            node.side = side;
            node.parent = undefined;
            node.text = snippet(await this.rangeLabel(edge, side), 70);
            node.edges = [];
            this.rangeNodes.set(key, node);
        }
        for (const key of [...this.rangeNodes.keys()]) {
            if (!liveRanges.has(key)) {
                this.rangeNodes.delete(key);
            }
        }
        // Edge nodes hang off their source range and lead to the shared target node.
        const liveEdges = new Set<StoredEdge>();
        for (const edge of edges) {
            const source = this.rangeNodes.get(keyOf(edge, 'from'));
            if (!source) {
                continue;
            }
            liveEdges.add(edge);
            const node = this.edgeNodes.get(edge) ?? { kind: 'edge', edge, child: undefined };
            node.edge = edge;
            node.child = this.rangeNodes.get(keyOf(edge, 'to'));
            node.parent = source;
            this.edgeNodes.set(edge, node);
            source.edges.push(node);
        }
        for (const edge of [...this.edgeNodes.keys()]) {
            if (!liveEdges.has(edge)) {
                this.edgeNodes.delete(edge);
            }
        }
        for (const range of this.rangeNodes.values()) {
            range.edges.sort((a, b) => a.edge.to.file.localeCompare(b.edge.to.file) || a.edge.to.lines[0] - b.edge.to.lines[0]);
        }
        // Derived ranges hang under the first edge deriving them.
        for (const range of this.rangeNodes.values()) {
            if (sources.has(range.key)) {
                continue;
            }
            const incoming = edges.find(edge => keyOf(edge, 'to') === range.key);
            range.parent = incoming ? this.edgeNodes.get(incoming) : undefined;
        }
        // Group the sources into root files.
        const byFile = new Map<string, OverviewRange[]>();
        for (const key of sources) {
            const range = this.rangeNodes.get(key);
            if (range) {
                const list = byFile.get(range.edge.from.file) ?? [];
                list.push(range);
                byFile.set(range.edge.from.file, list);
            }
        }
        const liveFiles = new Set<string>();
        this.files = [...byFile.entries()]
            .map(([file, ranges]) => {
                liveFiles.add(file);
                ranges.sort((a, b) => a.edge.from.lines[0] - b.edge.from.lines[0]);
                const node = this.fileNodes.get(file) ?? { kind: 'file', file, ranges: [] };
                node.ranges = ranges;
                this.fileNodes.set(file, node);
                for (const range of ranges) {
                    range.parent = node;
                }
                return node;
            })
            .sort((a, b) => a.file.localeCompare(b.file));
        for (const file of [...this.fileNodes.keys()]) {
            if (!liveFiles.has(file)) {
                this.fileNodes.delete(file);
            }
        }
    }

    /** The node the view reveals for `uri`: its earliest range taking part in the chain. */
    nodeFor(uri: vscode.Uri): OverviewRange | undefined {
        let target: OverviewRange | undefined;
        let top = Number.POSITIVE_INFINITY;
        for (const node of this.rangeNodes.values()) {
            if (this.store.endpointUri(node.edge, node.side).fsPath !== uri.fsPath) {
                continue;
            }
            if (node.edge[node.side].lines[0] < top) {
                top = node.edge[node.side].lines[0];
                target = node;
            }
        }
        return target;
    }

    /** The chain node covering `line` in `uri`, if the graph reaches that position. */
    private nodeAt(uri: vscode.Uri, line: number): OverviewRange | undefined {
        for (const node of this.rangeNodes.values()) {
            const range = this.store.endpointRange(node.edge, node.side);
            if (line >= range.start.line && line < range.end.line && this.store.endpointUri(node.edge, node.side).fsPath === uri.fsPath) {
                return node;
            }
        }
        return undefined;
    }

    /** Recomputes the derivation path of the range under the cursor; returns whether it changed. */
    private updateCursorPath(): boolean {
        const previousNode = this.cursorNode;
        const previousPath = this.cursorPath;
        const editor = vscode.window.activeTextEditor;
        const position = editor?.selections[0]?.active;
        const node = editor && position ? this.nodeAt(editor.document.uri, position.line) : undefined;
        const path = new Set<OverviewNode>();
        for (let current: OverviewNode | null = node ?? null; current !== null; current = this.getParent(current)) {
            path.add(current);
        }
        this.cursorNode = node;
        this.cursorPath = path;
        return previousNode !== node || path.size !== previousPath.size || [...path].some(item => !previousPath.has(item));
    }

    private async rangeLabel(edge: StoredEdge, side: EdgeSide): Promise<string> {
        const range = this.store.endpointRange(edge, side);
        return rangeText(this.store.endpointUri(edge, side), range.start.line);
    }

    /** Whether `uri` is the document currently open in the editor. */
    private isActive(uri: vscode.Uri): boolean {
        const active = vscode.window.activeTextEditor?.document.uri;
        return active !== undefined && active.fsPath === uri.fsPath;
    }

    getParent(element: OverviewNode): OverviewNode | null {
        return element.kind === 'file' ? null : element.parent ?? null;
    }

    getChildren(element?: OverviewNode): OverviewNode[] {
        if (!element) {
            return this.files;
        }
        if (element.kind === 'file') {
            return element.ranges;
        }
        if (element.kind === 'range') {
            return element.edges;
        }
        return element.child ? [element.child] : [];
    }

    getTreeItem(node: OverviewNode): vscode.TreeItem {
        const onPath = this.cursorPath.has(node);
        if (node.kind === 'file') {
            const first = node.ranges[0];
            const active = this.isActive(this.store.endpointUri(first.edge, first.side));
            const item = new vscode.TreeItem(highlightLabel(node.file, active), vscode.TreeItemCollapsibleState.Expanded);
            item.description = `${node.ranges.length} ${node.ranges.length === 1 ? 'source' : 'sources'}`;
            item.iconPath = new vscode.ThemeIcon('file', onPath ? PATH_TINT : active ? ACTIVE_TINT : undefined);
            item.command = revealCommand(this.store.endpointUri(first.edge, first.side), this.store.endpointRange(first.edge, first.side));
            return item;
        }
        if (node.kind === 'range') {
            const endpoint = node.edge[node.side];
            const uri = this.store.endpointUri(node.edge, node.side);
            const active = this.isActive(uri);
            const focused = node === this.cursorNode;
            const label = node.text || `${endpoint.file}:${endpoint.lines[0]}`;
            const item = new vscode.TreeItem(highlightLabel(label, focused || active), vscode.TreeItemCollapsibleState.Collapsed);
            item.description = `${path.basename(endpoint.file)}:${endpoint.lines[0]}${endpoint.lines[1] > endpoint.lines[0] ? `-${endpoint.lines[1]}` : ''}`;
            item.iconPath = new vscode.ThemeIcon('circle-filled', onPath ? PATH_TINT : active ? ACTIVE_TINT : undefined);
            item.tooltip = node.text || undefined;
            item.command = revealCommand(uri, this.store.endpointRange(node.edge, node.side));
            return item;
        }
        const target = node.edge.to;
        // An edge relates to the active document through either of its endpoints.
        const active = this.isActive(this.store.endpointUri(node.edge, 'from')) || this.isActive(this.store.endpointUri(node.edge, 'to'));
        const item = new vscode.TreeItem(highlightLabel(`${path.basename(target.file)}:${target.lines[0]}`, active), vscode.TreeItemCollapsibleState.Collapsed);
        item.description = snippet(node.edge.rationale, 60);
        item.tooltip = new vscode.MarkdownString(`**${target.file}:${target.lines[0]}-${target.lines[1]}**\n\n${node.edge.rationale}`);
        item.iconPath = new vscode.ThemeIcon('arrow-right', onPath ? PATH_TINT : active ? ACTIVE_TINT : undefined);
        item.command = revealCommand(this.store.endpointUri(node.edge, 'to'), this.store.endpointRange(node.edge, 'to'));
        return item;
    }
}

// ---------------------------------------------------------------------------
// Current file: everything the active document takes part in, grouped From/To.
// ---------------------------------------------------------------------------

export interface FileGroup {
    kind: 'group';
    role: EdgeSide;
    ranges: FileRange[];
}

export interface FileRange {
    kind: 'range';
    /** `role:start-end` — also the highlight key when the cursor sits inside. */
    key: string;
    uri: vscode.Uri;
    range: vscode.Range;
    text: string;
    role: EdgeSide;
    edges: StoredEdge[];
}

/** One edge under a range: jumps to the endpoint on the far side. */
interface FileEdge {
    kind: 'edge';
    edge: StoredEdge;
    /** The side the current document plays in this edge. */
    role: EdgeSide;
}

export type CurrentFileNode = FileGroup | FileRange | FileEdge;

export class CurrentFileProvider implements vscode.TreeDataProvider<CurrentFileNode> {
    private readonly changeEmitter = new vscode.EventEmitter<CurrentFileNode | undefined>();
    readonly onDidChangeTreeData = this.changeEmitter.event;
    message = '';
    /** Key of the range the cursor currently sits in; undefined when it is outside every range. */
    private highlightedKey: string | undefined;
    /** Stable node objects — the view keeps expansion state by identity. */
    private readonly groupNodes = new Map<EdgeSide, FileGroup>();
    private readonly rangeNodes = new Map<string, FileRange>();

    constructor(private readonly store: RationaleStore) {
        store.onDidChange(() => this.refresh());
        vscode.window.onDidChangeActiveTextEditor(() => this.refresh());
        vscode.workspace.onDidChangeTextDocument(() => this.refresh());
        vscode.window.onDidChangeTextEditorSelection(({ textEditor }) => {
            // Only the highlight depends on the cursor; re-render only when it moved in or out.
            if (textEditor === vscode.window.activeTextEditor && this.updateHighlight()) {
                this.changeEmitter.fire(undefined);
            }
        });
    }

    refresh(): void {
        const document = vscode.window.activeTextEditor?.document;
        if (!document) {
            this.message = 'Open a file to see its deductions';
        } else if (this.store.incomingTo(document.uri).length + this.store.edgesIn(document.uri, 'from').length === 0) {
            this.message = 'No deductions in this document';
        } else {
            this.message = '';
        }
        this.updateHighlight();
        this.changeEmitter.fire(undefined);
    }

    /** Recomputes the cursor highlight; returns whether it changed. */
    private updateHighlight(): boolean {
        const before = this.highlightedKey;
        const editor = vscode.window.activeTextEditor;
        const position = editor?.selections[0]?.active;
        this.highlightedKey = editor && position ? this.rangeKeyAt(editor.document.uri, position.line) : undefined;
        return before !== this.highlightedKey;
    }

    /** Key of the range covering `line` in `uri`, on either side — the entry the cursor points at. */
    private rangeKeyAt(uri: vscode.Uri, line: number): string | undefined {
        for (const role of ['from', 'to'] as const) {
            for (const edge of this.store.edgesIn(uri, role)) {
                const range = this.store.endpointRange(edge, role);
                if (line >= range.start.line && line < range.end.line) {
                    return `${role}:${range.start.line}-${range.end.line}`;
                }
            }
        }
        return undefined;
    }

    async getChildren(element?: CurrentFileNode): Promise<CurrentFileNode[]> {
        const document = vscode.window.activeTextEditor?.document;
        if (!document) {
            this.groupNodes.clear();
            this.rangeNodes.clear();
            return [];
        }
        if (!element) {
            const groups: FileGroup[] = [];
            const liveRanges = new Set<string>();
            for (const role of ['from', 'to'] as const) {
                const edges = this.store.edgesIn(document.uri, role);
                if (edges.length === 0) {
                    continue;
                }
                const ranges = await this.buildRanges(document.uri, role, edges);
                for (const range of ranges) {
                    liveRanges.add(range.key);
                }
                const group = this.groupNodes.get(role) ?? { kind: 'group', role, ranges: [] };
                group.ranges = ranges;
                this.groupNodes.set(role, group);
                groups.push(group);
            }
            for (const key of [...this.rangeNodes.keys()]) {
                if (!liveRanges.has(key)) {
                    this.rangeNodes.delete(key);
                }
            }
            return groups;
        }
        if (element.kind === 'group') {
            return [...element.ranges].sort((a, b) => a.range.start.line - b.range.start.line);
        }
        if (element.kind === 'range') {
            return element.edges.map(edge => ({ kind: 'edge', edge, role: element.role }));
        }
        return [];
    }

    private async buildRanges(uri: vscode.Uri, role: EdgeSide, edges: readonly StoredEdge[]): Promise<FileRange[]> {
        const ranges = new Map<string, FileRange>();
        for (const edge of edges) {
            const range = this.store.endpointRange(edge, role);
            const key = `${role}:${range.start.line}-${range.end.line}`;
            const node = this.rangeNodes.get(key) ?? { kind: 'range', key, uri, range, text: '', role, edges: [] };
            const firstTouch = !ranges.has(key);
            node.uri = uri;
            node.range = range;
            node.role = role;
            if (firstTouch) {
                node.edges = [];
            }
            node.edges.push(edge);
            node.text = snippet(await rangeText(uri, range.start.line), 70);
            ranges.set(key, node);
            this.rangeNodes.set(key, node);
        }
        return [...ranges.values()];
    }

    getTreeItem(node: CurrentFileNode): vscode.TreeItem {
        if (node.kind === 'group') {
            const item = new vscode.TreeItem(node.role === 'from' ? 'From' : 'To', vscode.TreeItemCollapsibleState.Expanded);
            const count = node.ranges.length;
            item.description = `${count} ${count === 1 ? 'range' : 'ranges'}`;
            item.iconPath = new vscode.ThemeIcon(node.role === 'from' ? 'arrow-right' : 'arrow-left');
            return item;
        }
        if (node.kind === 'range') {
            const highlighted = node.key === this.highlightedKey;
            const item = new vscode.TreeItem(highlightLabel(node.text || 'L' + (node.range.start.line + 1), highlighted), vscode.TreeItemCollapsibleState.Collapsed);
            const [start, end] = [node.range.start.line + 1, node.range.end.line];
            item.description = `L${start}${end > start ? `-${end}` : ''} · ${node.edges.length} ${node.edges.length === 1 ? 'edge' : 'edges'}`;
            item.tooltip = node.text || undefined;
            item.iconPath = new vscode.ThemeIcon(node.role === 'from' ? 'arrow-right' : 'arrow-left', highlighted ? new vscode.ThemeColor('charts.blue') : undefined);
            item.command = revealCommand(node.uri, node.range);
            return item;
        }
        const other: EdgeSide = node.role === 'from' ? 'to' : 'from';
        const endpoint = node.edge[other];
        const item = new vscode.TreeItem(`${path.basename(endpoint.file)}:${endpoint.lines[0]}`);
        item.description = snippet(node.edge.rationale, 60);
        item.tooltip = new vscode.MarkdownString(`**${endpoint.file}:${endpoint.lines[0]}-${endpoint.lines[1]}**\n\n${node.edge.rationale}`);
        item.iconPath = new vscode.ThemeIcon(node.role === 'from' ? 'arrow-right' : 'arrow-left');
        item.command = revealCommand(this.store.endpointUri(node.edge, other), this.store.endpointRange(node.edge, other));
        return item;
    }
}

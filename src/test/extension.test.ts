import * as assert from 'assert';

// You can import and use all API from the 'vscode' module
// as well as import your extension to test it
import * as vscode from 'vscode';
import { parseRationaleDocument, RationaleStore } from '../rationaleStore';
import { DeductionOverviewProvider, CurrentFileProvider, OverviewNode } from '../deductionTree';

const VALID_EDGE = '{"from":{"file":"a.md","lines":[3,15]},"to":{"file":"b.md","lines":[19,54]},"rationale":"why b follows from a"}';

suite('Extension Test Suite', () => {
	vscode.window.showInformationMessage('Start all tests.');

	test('Sample test', () => {
		assert.strictEqual(-1, [1, 2, 3].indexOf(5));
		assert.strictEqual(-1, [1, 2, 3].indexOf(0));
	});

	suite('parseRationaleDocument', () => {
		test('parses a valid document', () => {
			const { edges, errors, fatal } = parseRationaleDocument(`{"edges":[${VALID_EDGE},${VALID_EDGE}]}`);
			assert.strictEqual(edges.length, 2);
			assert.strictEqual(errors.length, 0);
			assert.strictEqual(fatal, false);
			assert.deepStrictEqual(edges[0].from, { file: 'a.md', lines: [3, 15] });
			assert.strictEqual(edges[0].rationale, 'why b follows from a');
		});

		test('accepts an empty edge list', () => {
			const { edges, fatal } = parseRationaleDocument('{"edges":[]}');
			assert.strictEqual(edges.length, 0);
			assert.strictEqual(fatal, false);
		});

		test('is fatal on invalid JSON', () => {
			const { edges, errors, fatal } = parseRationaleDocument('{"edges":[');
			assert.strictEqual(edges.length, 0);
			assert.strictEqual(fatal, true);
			assert.match(errors[0], /invalid JSON document/);
		});

		test('is fatal without a top-level edges array', () => {
			const { edges, errors, fatal } = parseRationaleDocument('{"foo":1}');
			assert.strictEqual(edges.length, 0);
			assert.strictEqual(fatal, true);
			assert.match(errors[0], /"edges" array/);
		});

		test('rejects invalid entries but keeps valid ones', () => {
			const badRange = '{"from":{"file":"a.md","lines":[5,3]},"to":{"file":"b.md","lines":[1,2]},"rationale":"r"}';
			const noRationale = '{"from":{"file":"a.md","lines":[1,2]},"to":{"file":"b.md","lines":[3,4]}}';
			const { edges, errors, fatal } = parseRationaleDocument(`{"edges":[${VALID_EDGE},${badRange},${noRationale}]}`);
			assert.strictEqual(edges.length, 1);
			assert.strictEqual(fatal, false);
			assert.match(errors[0], /edges\[1\]: from\.lines/);
			assert.match(errors[1], /edges\[2\]: rationale/);
		});
	});
});

suite('DeductionOverviewProvider', () => {
	test('locates and highlights files with only incoming edges', async function () {
		this.timeout(20000);
		// The test host opens an empty window; the store scans the workspace, so add the repo root.
		if (vscode.workspace.workspaceFolders === undefined || vscode.workspace.workspaceFolders.length === 0) {
			const opened = new Promise<void>(resolve => vscode.workspace.onDidChangeWorkspaceFolders(() => resolve()));
			const root = vscode.Uri.joinPath(vscode.Uri.file(__dirname), '..', '..');
			assert.ok(vscode.workspace.updateWorkspaceFolders(0, 0, { uri: root }));
			await opened;
		}

		// Integration test over the repository's own dogfooding edges.
		const store = new RationaleStore();
		await store.reload();
		assert.ok(store.edgeCount > 0, `the dogfooding rationale.json must provide edges (workspace: ${vscode.workspace.workspaceFolders?.[0]?.uri.fsPath})`);

		// Pick, fully dynamically, a file that never appears as a `from` — a pure leaf of the DAG.
		const outgoing = new Set(store.allEdges.map(edge => edge.from.file));
		const leafEdge = store.allEdges.find(edge => !outgoing.has(edge.to.file));
		assert.ok(leafEdge, 'the graph must contain at least one file with only incoming edges');
		const leafUri = store.endpointUri(leafEdge, 'to');

		const provider = new DeductionOverviewProvider(store);
		await provider.refresh();

		// The reveal target resolves to a node inside the leaf file…
		const target = provider.nodeFor(leafUri);
		assert.ok(target, 'a node must exist for the leaf file');
		assert.strictEqual(store.endpointUri(target.edge, target.side).fsPath, leafUri.fsPath);

		// …and it is reachable from the root files, i.e. the chain the view expands along.
		const seen = new Set<OverviewNode>();
		const walk = (nodes: readonly OverviewNode[]): void => {
			for (const node of nodes) {
				if (seen.has(node)) {
					continue;
				}
				seen.add(node);
				walk(provider.getChildren(node));
			}
		};
		walk(provider.getChildren());
		assert.ok(seen.has(target), 'the leaf node must be reachable from the root files');

		// Its parent chain climbs back to a root file without gaps.
		let ancestor: OverviewNode | null = provider.getParent(target);
		const ancestors: OverviewNode[] = [];
		while (ancestor !== null) {
			ancestors.push(ancestor);
			ancestor = provider.getParent(ancestor);
		}
		assert.ok(ancestors.length > 0 && ancestors[ancestors.length - 1].kind === 'file', 'the path must end at a root file');

		// Opening the leaf file marks its node with the highlight label.
		const document = await vscode.workspace.openTextDocument(leafUri);
		await vscode.window.showTextDocument(document);
		const item = provider.getTreeItem(target);
		const label = item.label as vscode.TreeItemLabel;
		assert.ok(Array.isArray(label?.highlights) && label.highlights.length > 0, 'the active leaf must be highlighted');

		await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
	});

	test('marks the derivation path of the cursor in a distinct tint', async function () {
		this.timeout(20000);
		if (vscode.workspace.workspaceFolders === undefined || vscode.workspace.workspaceFolders.length === 0) {
			const opened = new Promise<void>(resolve => vscode.workspace.onDidChangeWorkspaceFolders(() => resolve()));
			const root = vscode.Uri.joinPath(vscode.Uri.file(__dirname), '..', '..');
			assert.ok(vscode.workspace.updateWorkspaceFolders(0, 0, { uri: root }));
			await opened;
		}

		const store = new RationaleStore();
		await store.reload();
		const outgoing = new Set(store.allEdges.map(edge => edge.from.file));
		const leafEdge = store.allEdges.find(edge => !outgoing.has(edge.to.file));
		assert.ok(leafEdge);
		const leafUri = store.endpointUri(leafEdge, 'to');

		const provider = new DeductionOverviewProvider(store);
		await provider.refresh();
		const target = provider.nodeFor(leafUri);
		assert.ok(target);

		const document = await vscode.workspace.openTextDocument(leafUri);
		const editor = await vscode.window.showTextDocument(document);
		const line = store.endpointRange(target.edge, target.side).start.line;
		editor.selection = new vscode.Selection(line, 0, line, 0);
		await provider.refresh();

		// The whole derivation path — cursor node up to the root file — carries the path tint.
		const PATH_TINT = 'gitDecoration.addedResourceForeground';
		const tintOf = (item: vscode.TreeItem): string | undefined => (item.iconPath as vscode.ThemeIcon).color?.id;
		const pathNodes: OverviewNode[] = [];
		for (let current: OverviewNode | null = target; current !== null; current = provider.getParent(current)) {
			pathNodes.push(current);
			assert.strictEqual(tintOf(provider.getTreeItem(current)), PATH_TINT, `node #${pathNodes.length} on the path must be green`);
		}
		assert.ok(pathNodes[pathNodes.length - 1].kind === 'file', 'the path must climb up to a root file');

		// A sibling range of the same file stays at the file-level blue tint.
		const sibling = provider.getChildren()
			.flatMap(node => node.kind === 'file' ? node.ranges : [])
			.find(node => node !== target && store.endpointUri(node.edge, node.side).fsPath === leafUri.fsPath);
		if (sibling) {
			assert.strictEqual(tintOf(provider.getTreeItem(sibling)), 'charts.blue', 'siblings stay file-level blue');
		}

		await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
	});
});

suite('CurrentFileProvider', () => {
	test('highlights the range under the cursor', async function () {
		this.timeout(20000);
		if (vscode.workspace.workspaceFolders === undefined || vscode.workspace.workspaceFolders.length === 0) {
			const opened = new Promise<void>(resolve => vscode.workspace.onDidChangeWorkspaceFolders(() => resolve()));
			const root = vscode.Uri.joinPath(vscode.Uri.file(__dirname), '..', '..');
			assert.ok(vscode.workspace.updateWorkspaceFolders(0, 0, { uri: root }));
			await opened;
		}

		const store = new RationaleStore();
		await store.reload();
		const outgoing = new Set(store.allEdges.map(edge => edge.from.file));
		const leafEdge = store.allEdges.find(edge => !outgoing.has(edge.to.file));
		assert.ok(leafEdge, 'the graph must contain at least one file with only incoming edges');
		const leafUri = store.endpointUri(leafEdge, 'to');

		const provider = new CurrentFileProvider(store);
		const document = await vscode.workspace.openTextDocument(leafUri);
		const editor = await vscode.window.showTextDocument(document);
		const groups = await provider.getChildren();
		const group = groups.find(node => node.kind === 'group' && node.role === 'to');
		assert.ok(group && group.kind === 'group' && group.ranges.length > 0, 'the To group must list ranges');

		// Put the cursor inside the first range: that range lights up.
		const target = group.kind === 'group' ? group.ranges[0] : undefined;
		assert.ok(target);
		const line = target.range.start.line;
		editor.selection = new vscode.Selection(line, 0, line, 0);
		provider.refresh();
		const label = provider.getTreeItem(target).label as vscode.TreeItemLabel;
		assert.ok(Array.isArray(label?.highlights) && label.highlights.length > 0, 'the range under the cursor must be highlighted');

		// Any other range stays plain.
		if (group.kind === 'group' && group.ranges.length > 1) {
			const other = group.ranges[1];
			assert.strictEqual(typeof provider.getTreeItem(other).label, 'string', 'other ranges must not be highlighted');
		}

		await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
	});
});

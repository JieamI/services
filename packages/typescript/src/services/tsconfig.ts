import * as jsonc from 'jsonc-parser';
import { minimatch } from 'minimatch';
import * as vscode from '@volar/language-service';
import { URI, Utils } from 'vscode-uri';
import { SharedContext } from '../types';

interface OpenExtendsLinkCommandArgs {
	resourceUri: string;
	extendsValue: string;
}

function mapChildren<R>(node: jsonc.Node | undefined, f: (x: jsonc.Node) => R): R[] {
	return node && node.type === 'array' && node.children
		? node.children.map(f)
		: [];
}

export function register(ctx: SharedContext) {

	const patterns = [
		'**/[jt]sconfig.json',
		'**/[jt]sconfig.*.json',
	];
	const languages = ['json', 'jsonc'];

	return {
		provideDocumentLinks,
		async resolve(link: vscode.DocumentLink, _token: vscode.CancellationToken) {
			const data: OpenExtendsLinkCommandArgs = link.data;
			if (data) {
				const tsconfigPath = await getTsconfigPath(Utils.dirname(URI.parse(data.resourceUri)), data.extendsValue);
				if (tsconfigPath === undefined) {
					// console.error(vscode.l10n.t("Failed to resolve {0} as module", data.extendsValue));
				}
				link.target = tsconfigPath?.toString();
			}
			return link;
		},
	};


	function provideDocumentLinks(
		document: vscode.TextDocument,
		_token: vscode.CancellationToken
	): vscode.DocumentLink[] {

		const match = languages.includes(document.languageId) && patterns.some(pattern => minimatch(document.uri, pattern));
		if (!match) {
			return [];
		}

		const root = jsonc.parseTree(document.getText());
		if (!root) {
			return [];
		}

		const links = [
			getExtendsLink(document, root),
			...getFilesLinks(document, root),
			...getReferencesLinks(document, root)
		];
		return links.filter(link => !!link) as vscode.DocumentLink[];
	}

	function getExtendsLink(document: vscode.TextDocument, root: jsonc.Node): vscode.DocumentLink | undefined {
		const extendsNode = jsonc.findNodeAtLocation(root, ['extends']);
		if (!isPathValue(extendsNode)) {
			return undefined;
		}

		const extendsValue: string = extendsNode.value;
		if (extendsValue.startsWith('/')) {
			return undefined;
		}

		const args: OpenExtendsLinkCommandArgs = {
			resourceUri: document.uri,
			extendsValue: extendsValue
		};

		const link = vscode.DocumentLink.create(
			getRange(document, extendsNode),
			undefined,
			args
		);
		// link.tooltip = vscode.l10n.t("Follow link");
		link.tooltip = "Follow link";
		return link;
	}

	function getFilesLinks(document: vscode.TextDocument, root: jsonc.Node) {
		return mapChildren(
			jsonc.findNodeAtLocation(root, ['files']),
			child => pathNodeToLink(document, child));
	}

	function getReferencesLinks(document: vscode.TextDocument, root: jsonc.Node) {
		return mapChildren(
			jsonc.findNodeAtLocation(root, ['references']),
			child => {
				const pathNode = jsonc.findNodeAtLocation(child, ['path']);
				if (!isPathValue(pathNode)) {
					return undefined;
				}

				return vscode.DocumentLink.create(
					getRange(document, pathNode),
					pathNode.value.endsWith('.json')
						? getFileTarget(document, pathNode)
						: getFolderTarget(document, pathNode)
				);
			});
	}

	function pathNodeToLink(
		document: vscode.TextDocument,
		node: jsonc.Node | undefined
	): vscode.DocumentLink | undefined {
		return isPathValue(node)
			? vscode.DocumentLink.create(getRange(document, node), getFileTarget(document, node))
			: undefined;
	}

	function isPathValue(extendsNode: jsonc.Node | undefined): extendsNode is jsonc.Node {
		return extendsNode
			&& extendsNode.type === 'string'
			&& extendsNode.value
			&& !(extendsNode.value as string).includes('*'); // don't treat globs as links.
	}

	function getFileTarget(document: vscode.TextDocument, node: jsonc.Node): string {
		return Utils.joinPath(Utils.dirname(URI.parse(document.uri)), node.value).toString();
	}

	function getFolderTarget(document: vscode.TextDocument, node: jsonc.Node): string {
		return Utils.joinPath(Utils.dirname(URI.parse(document.uri)), node.value, 'tsconfig.json').toString();
	}

	function getRange(document: vscode.TextDocument, node: jsonc.Node) {
		const offset = node.offset;
		const start = document.positionAt(offset + 1);
		const end = document.positionAt(offset + (node.length - 1));
		return vscode.Range.create(start, end);
	}

	async function resolveNodeModulesPath(baseDirUri: URI, pathCandidates: string[]): Promise<URI | undefined> {
		let currentUri = baseDirUri;
		const baseCandidate = pathCandidates[0];
		const sepIndex = baseCandidate.startsWith('@') ? 2 : 1;
		const moduleBasePath = baseCandidate.split('/').slice(0, sepIndex).join('/');
		while (true) {
			const moduleAbsoluteUrl = Utils.joinPath(currentUri, 'node_modules', moduleBasePath);
			let moduleStat: Awaited<ReturnType<NonNullable<typeof ctx.env.fileSystemProvider>['stat']>> | undefined;
			try {
				moduleStat = await ctx.env.fileSystemProvider?.stat(moduleAbsoluteUrl.toString());
			} catch (err) {
				// noop
			}

			if (moduleStat && moduleStat.type === 2 /* Directory */) {
				for (const uriCandidate of pathCandidates
					.map((relativePath) => relativePath.split('/').slice(sepIndex).join('/'))
					// skip empty paths within module
					.filter(Boolean)
					.map((relativeModulePath) => Utils.joinPath(moduleAbsoluteUrl, relativeModulePath))
				) {
					if (await exists(uriCandidate)) {
						return uriCandidate;
					}
				}
				// Continue to looking for potentially another version
			}

			const oldUri = currentUri;
			currentUri = Utils.joinPath(currentUri, '..');

			// Can't go next. Reached the system root
			if (oldUri.path === currentUri.path) {
				return;
			}
		}
	}

	// Reference: https://github.com/microsoft/TypeScript/blob/febfd442cdba343771f478cf433b0892f213ad2f/src/compiler/commandLineParser.ts#L3005
	/**
	* @returns Returns undefined in case of lack of result while trying to resolve from node_modules
	*/
	async function getTsconfigPath(baseDirUri: URI, extendsValue: string): Promise<URI | undefined> {
		// Don't take into account a case, where tsconfig might be resolved from the root (see the reference)
		// e.g. C:/projects/shared-tsconfig/tsconfig.json (note that C: prefix is optional)

		const isRelativePath = ['./', '../'].some(str => extendsValue.startsWith(str));
		if (isRelativePath) {
			const absolutePath = Utils.joinPath(baseDirUri, extendsValue);
			if (await exists(absolutePath) || absolutePath.path.endsWith('.json')) {
				return absolutePath;
			}
			return absolutePath.with({
				path: `${absolutePath.path}.json`
			});
		}

		// Otherwise resolve like a module
		return resolveNodeModulesPath(baseDirUri, [
			extendsValue,
			...extendsValue.endsWith('.json') ? [] : [
				`${extendsValue}.json`,
				`${extendsValue}/tsconfig.json`,
			]
		]);
	}

	async function exists(resource: URI): Promise<boolean> {
		try {
			const stat = await ctx.env.fileSystemProvider?.stat(resource.toString());
			// stat.type is an enum flag
			return !!(stat?.type === 1);
		} catch {
			return false;
		}
	}
}

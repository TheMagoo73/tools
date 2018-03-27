/**
 * @license
 * Copyright (c) 2018 The Polymer Project Authors. All rights reserved.
 * This code may only be used under the BSD style license found at
 * http://polymer.github.io/LICENSE.txt
 * The complete set of authors may be found at
 * http://polymer.github.io/AUTHORS.txt
 * The complete set of contributors may be found at
 * http://polymer.github.io/CONTRIBUTORS.txt
 * Code distributed by Google as part of the polymer project is also
 * subject to an additional IP rights grant found at
 * http://polymer.github.io/PATENTS.txt
 */
import traverse, {NodePath} from 'babel-traverse';
import * as babel from 'babel-types';
import {Analyzer, ResolvedUrl} from 'polymer-analyzer';

import {getAnalysisDocument} from './analyzer-utils';
import {AssignedBundle, BundleManifest} from './bundle-manifest';
import {getFileName} from './url-utils';
import {camelCase} from './utils';

/**
 * Looks up and/or defines the unique name for an item exported with the given
 * name in a module within a bundle.
 */
export function getOrSetBundleModuleExportName(
    bundle: AssignedBundle, moduleUrl: ResolvedUrl, name: string): string {
  let moduleExports = bundle.bundle.bundledExports.get(moduleUrl);
  const bundledExports = bundle.bundle.bundledExports;
  if (!moduleExports) {
    moduleExports = new Map<string, string>();
    bundledExports.set(moduleUrl, moduleExports);
  }
  let exportName = moduleExports.get(name);
  if (!exportName) {
    let trialName = name;
    let moduleFileNameIdentifier =
        '$' + camelCase(getFileName(moduleUrl).replace(/\.[a-z0-9_]+$/, ''));
    trialName =
        trialName.replace(/^default$/, `${moduleFileNameIdentifier}Default`)
            .replace(/^\*$/, moduleFileNameIdentifier)
            .replace(/[^a-z0-9_]/gi, '$');
    while (!exportName) {
      if ([...bundledExports.values()].every(
              (map) => [...map.values()].indexOf(trialName) === -1)) {
        exportName = trialName;
      } else {
        if (trialName.match(/\$[0-9]+$/)) {
          trialName = trialName.replace(/[0-9]+$/, (v) => `${parseInt(v) + 1}`);
        } else {
          trialName = `${trialName}$1`;
        }
      }
    }
    moduleExports.set(name, exportName);
  }
  return exportName;
}

/**
 * Returns true if a module has a default export.
 *
 * TODO(usergenic): This does not identify a named export with exported
 * identifier of `default`.
 * https://github.com/Polymer/polymer-bundler/issues/645
 */
export function hasDefaultModuleExport(node: babel.Node): boolean {
  let hasDefaultModuleExport = false;
  traverse(node, {
    noScope: true,
    ExportDefaultDeclaration: {
      enter(path: NodePath) {
        hasDefaultModuleExport = true;
        path.stop();
      }
    }
  });
  return hasDefaultModuleExport;
}

/**
 * Returns a set of every name exported by a module.
 *
 * TODO(usergenic): This does not include names brought in by the statement
 * `export * from './module-a.js';`.
 * https://github.com/Polymer/polymer-bundler/issues/641
 */
export function getModuleExportNames(node: babel.Node): Set<string> {
  const exportedNames: string[] = [];
  traverse(node, {
    noScope: true,
    ExportNamedDeclaration: {
      enter(path: NodePath) {
        const exportNode = path.node as babel.ExportNamedDeclaration;
        exportedNames.push(
            ...getModuleExportIdentifiers(...exportNode.specifiers));
        exportedNames.push(
            ...getModuleExportIdentifiers(exportNode.declaration));
      }
    }
  });
  return new Set(exportedNames);
}

/**
 * Returns an array of strings representing all export identifiers for each of
 * the provided nodes which are part of an ExportNamedDeclaration.
 */
function getModuleExportIdentifiers(...nodes: babel.Node[]): string[] {
  const identifiers = [];
  for (const node of nodes) {
    if (babel.isArrayPattern(node)) {
      identifiers.push(...getModuleExportIdentifiers(...node.elements));
    }
    if (babel.isClassDeclaration(node) || babel.isFunctionDeclaration(node) ||
        babel.isVariableDeclarator(node)) {
      identifiers.push(...getModuleExportIdentifiers(node.id));
    }
    if (babel.isExportSpecifier(node)) {
      identifiers.push(...getModuleExportIdentifiers(node.exported));
    }
    if (babel.isIdentifier(node)) {
      identifiers.push(node.name);
    }
    if (babel.isObjectPattern(node)) {
      identifiers.push(...getModuleExportIdentifiers(...node.properties));
    }
    if (babel.isObjectProperty(node)) {
      identifiers.push(...getModuleExportIdentifiers(node.value));
    }
    if (babel.isVariableDeclaration(node)) {
      identifiers.push(...getModuleExportIdentifiers(...node.declarations));
    }
  }
  return identifiers;
}

/**
 * Ensures that exported names from modules which have the same URL as their
 * bundle will have precedence over other module exports, which will be
 * counter-suffixed in the event of name collisions.  This has no technical
 * benefit, but it results in module export naming choices that are easier
 * to reason about for developers and may aid in debugging.
 */
export async function reserveBundleModuleExportNames(
    analyzer: Analyzer, manifest: BundleManifest) {
  const es6ModuleBundles =
      [...manifest.bundles]
          .map(([url, bundle]) => ({url, bundle}))
          .filter(({bundle}) => bundle.type === 'es6-module');
  const analysis = await analyzer.analyze(es6ModuleBundles.map(({url}) => url));
  for (const {url, bundle} of es6ModuleBundles) {
    if (bundle.files.has(url)) {
      const document = getAnalysisDocument(analysis, url);
      for (const exportName of getModuleExportNames(
               document.parsedDocument.ast as any)) {
        getOrSetBundleModuleExportName({url, bundle}, url, exportName);
      }
    }
  }
}

import type { Plugin } from 'vite';
import * as ts from 'typescript';

export function reactiveReactPlugin(): Plugin {
  return {
    name: 'reactive-react-transform',
    enforce: 'pre',

    transform(code: string, id: string) {
      // Only process .tsx and .jsx files
      if (!id.endsWith('.tsx') && !id.endsWith('.jsx')) {
        return null;
      }

      // Skip the plugin file itself and lib files
      if (id.includes('/lib/')) {
        return null;
      }

      const sourceFile = ts.createSourceFile(
        id,
        code,
        ts.ScriptTarget.Latest,
        true,
        id.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.JSX
      );

      const componentsToTransform: Array<{
        name: string;
        start: number;
        end: number;
        isExported: boolean;
        isDefaultExport: boolean;
      }> = [];

      let needsReactiveImport = false;

      function visit(node: ts.Node) {
        // Check for function declarations
        if (ts.isFunctionDeclaration(node) && node.name) {
          const componentName = node.name.text;

          // Check if it's a component (starts with uppercase)
          if (componentName[0] === componentName[0].toUpperCase()) {
            if (node.body && returnsFunction(node.body)) {
              const isExported = node.modifiers?.some(
                m => m.kind === ts.SyntaxKind.ExportKeyword
              ) || false;
              const isDefaultExport = node.modifiers?.some(
                m => m.kind === ts.SyntaxKind.DefaultKeyword
              ) || false;

              componentsToTransform.push({
                name: componentName,
                start: node.getStart(sourceFile),
                end: node.getEnd(),
                isExported,
                isDefaultExport,
              });
              needsReactiveImport = true;
            }
          }
        }

        ts.forEachChild(node, visit);
      }

      function returnsFunction(body: ts.Block): boolean {
        let foundFunctionReturn = false;

        function checkReturn(node: ts.Node) {
          if (ts.isReturnStatement(node) && node.expression) {
            const expr = node.expression;

            // Check for arrow function: () => ...
            if (ts.isArrowFunction(expr)) {
              foundFunctionReturn = true;
              return;
            }

            // Check for function expression: function() { ... }
            if (ts.isFunctionExpression(expr)) {
              foundFunctionReturn = true;
              return;
            }
          }

          if (!foundFunctionReturn) {
            ts.forEachChild(node, checkReturn);
          }
        }

        checkReturn(body);
        return foundFunctionReturn;
      }

      visit(sourceFile);

      if (!needsReactiveImport || componentsToTransform.length === 0) {
        return null;
      }

      // Transform the code
      let transformed = code;

      // Sort by position (reverse order to maintain correct positions)
      componentsToTransform.sort((a, b) => b.start - a.start);

      for (const component of componentsToTransform) {
        const originalCode = code.substring(component.start, component.end);

        // Extract the function body and parameters
        const funcMatch = originalCode.match(
          /function\s+\w+\s*(\([^)]*\))\s*(\{[\s\S]*\})/
        );

        if (funcMatch) {
          const params = funcMatch[1];
          const body = funcMatch[2];

          let newCode: string;

          if (component.isDefaultExport) {
            newCode = `const ${component.name} = reactive(${params} => ${body});\nexport default ${component.name};`;
          } else if (component.isExported) {
            newCode = `export const ${component.name} = reactive(${params} => ${body});`;
          } else {
            newCode = `const ${component.name} = reactive(${params} => ${body});`;
          }

          transformed =
            transformed.substring(0, component.start) +
            newCode +
            transformed.substring(component.end);
        }
      }

      // Add the reactive import at the top
      const importStatement = `import { reactive } from './lib';\n`;

      // Find the position after any existing imports
      let insertPosition = 0;
      const lines = transformed.split('\n');

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line.startsWith('import ') || line.startsWith('import{')) {
          insertPosition = transformed.indexOf(lines[i]) + lines[i].length + 1;
        } else if (insertPosition > 0 && line && !line.startsWith('//')) {
          break;
        }
      }

      transformed =
        transformed.substring(0, insertPosition) +
        importStatement +
        transformed.substring(insertPosition);

      return {
        code: transformed,
        map: null,
      };
    },
  };
}

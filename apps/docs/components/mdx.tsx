import defaultMdxComponents from 'fumadocs-ui/mdx';
import type { MDXComponents } from 'mdx/types';
import React from 'react';
import { Mermaid } from './mermaid';

function extractText(node: any): string {
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  if (!node) return '';
  if (Array.isArray(node)) return node.map(extractText).join('');
  if (node.props?.children) return extractText(node.props.children);
  return '';
}

const MERMAID_REGEX =
  /^\s*(%%[^\n]*\n\s*)*(---[^\n]*\n[\s\S]*?---\s*)?(flowchart|graph|sequenceDiagram|stateDiagram|classDiagram|erDiagram|journey|gantt|pie|gitGraph|quadrantChart|xychart-beta|timeline|mindmap|C4Context|C4Container|C4Component|C4Dynamic|C4Deployment|sankey-beta|kanban|block-beta)\b/;

export function getMDXComponents(components?: MDXComponents) {
  const DefaultPre = defaultMdxComponents.pre;

  return {
    ...defaultMdxComponents,
    Mermaid,
    pre: (props: any) => {
      const isExplicitMermaid =
        props['data-language'] === 'mermaid' ||
        props.className?.includes('language-mermaid') ||
        props.children?.props?.className?.includes('language-mermaid') ||
        props.children?.props?.['data-language'] === 'mermaid';

      const text = extractText(props.children);
      const isMermaidSyntax = MERMAID_REGEX.test(text);

      if (isExplicitMermaid || isMermaidSyntax) {
        return <Mermaid chart={text} />;
      }

      if (DefaultPre) {
        return <DefaultPre {...props} />;
      }

      return <pre {...props} />;
    },
    ...components,
  } satisfies MDXComponents;
}

export const useMDXComponents = getMDXComponents;

declare global {
  type MDXProvidedComponents = ReturnType<typeof getMDXComponents>;
}

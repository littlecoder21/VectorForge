const SVG_NS = 'http://www.w3.org/2000/svg';
const serializer = new XMLSerializer();

export function formatSvgMarkup(markup: string): string {
  const document = new DOMParser().parseFromString(markup, 'image/svg+xml');
  if (document.querySelector('parsererror')) {
    throw new Error('Fix the SVG/XML errors before formatting the markup.');
  }
  const root = document.documentElement;
  if (root.localName !== 'svg' || root.namespaceURI !== SVG_NS) {
    throw new Error('The document root must be an SVG element.');
  }

  const formatElement = (element: Element, depth: number, parentNamespace: string | null): string => {
    const children = Array.from(element.childNodes).filter(node =>
      node.nodeType !== Node.TEXT_NODE || node.textContent?.trim(),
    );
    const indent = '  '.repeat(depth);
    let opening = serializer.serializeToString(element.cloneNode(false)).replace(/\/>$/, '>');
    if (parentNamespace === element.namespaceURI && element.namespaceURI) {
      opening = opening.replace(` xmlns="${element.namespaceURI}"`, '');
    }
    if (children.length === 0) {
      return `${indent}${opening.slice(0, -1)} />`;
    }
    if (children.some(node => node.nodeType === Node.TEXT_NODE)) {
      return `${indent}${serializer.serializeToString(element)}`;
    }

    const body = children.map(node => {
      if (node.nodeType === Node.ELEMENT_NODE) {
        return formatElement(node as Element, depth + 1, element.namespaceURI);
      }
      return `${'  '.repeat(depth + 1)}${serializer.serializeToString(node)}`;
    });
    return `${indent}${opening}\n${body.join('\n')}\n${indent}</${element.tagName}>`;
  };

  return formatElement(root, 0, null);
}

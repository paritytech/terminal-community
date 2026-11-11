/**
 * Builders for Pocket card faces: plain constructors for the renderer
 * protocol's JSON tree.
 *
 * Taken from paritytech/pocket-reciept (`shared/src/nodes.ts`). A face is a
 * handful of nodes, so a few constructors keep it plain data with no JSX
 * runtime in the worker bundle. Every face is still held to the protocol by
 * `validateFace` from `@parity/product-sdk-renderer`, in the tests and in
 * scripts/build-pocket-worker.mts.
 *
 * ASCII only: bundled into the Pocket worker, which the host reads as Latin-1.
 */

import type {
  Arrangement,
  ColorToken,
  ContentAlignment,
  Dimensions,
  HorizontalAlignment,
  Modifier,
  RendererNode,
  Shape,
  TypographyStyle,
  VerticalAlignment,
} from "@parity/product-sdk-renderer";

export type { ColorToken, Modifier, RendererNode, TypographyStyle };

const node = (tag: string, value: unknown): RendererNode => ({ tag, value }) as unknown as RendererNode;
const mod = (tag: string, value?: unknown): Modifier =>
  (value === undefined ? { tag } : { tag, value }) as unknown as Modifier;

/** Only the props that were given: the protocol's optional fields are absent, not null. */
function props(entries: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(entries).filter(([, v]) => v !== undefined));
}

interface NodeOptions {
  modifiers?: Modifier[];
}

export function box(children: RendererNode[], o: NodeOptions & { contentAlignment?: ContentAlignment } = {}): RendererNode {
  return node("Box", { modifiers: o.modifiers ?? [], props: props({ contentAlignment: o.contentAlignment }), children });
}

export function column(
  children: RendererNode[],
  o: NodeOptions & { horizontalAlignment?: HorizontalAlignment; verticalArrangement?: Arrangement } = {},
): RendererNode {
  return node("Column", {
    modifiers: o.modifiers ?? [],
    props: props({ horizontalAlignment: o.horizontalAlignment, verticalArrangement: o.verticalArrangement }),
    children,
  });
}

export function row(
  children: RendererNode[],
  o: NodeOptions & { verticalAlignment?: VerticalAlignment; horizontalArrangement?: Arrangement } = {},
): RendererNode {
  return node("Row", {
    modifiers: o.modifiers ?? [],
    props: props({ verticalAlignment: o.verticalAlignment, horizontalArrangement: o.horizontalArrangement }),
    children,
  });
}

/** A line of text, wrapped in the `String` child the protocol requires. */
export function text(content: string, o: NodeOptions & { style?: TypographyStyle; color?: ColorToken } = {}): RendererNode {
  return node("Text", {
    modifiers: o.modifiers ?? [],
    props: props({ style: o.style, color: o.color }),
    children: [node("String", { text: content })],
  });
}

export function spacer(o: { width?: number; height?: number }): RendererNode {
  const modifiers: Modifier[] = [];
  if (o.width !== undefined) modifiers.push(width(o.width));
  if (o.height !== undefined) modifiers.push(height(o.height));
  return node("Spacer", { modifiers });
}

export const fillWidth = (): Modifier => mod("FillWidth", true);
export const fillHeight = (): Modifier => mod("FillHeight", true);
export const width = (value: number): Modifier => mod("Width", value);
export const height = (value: number): Modifier => mod("Height", value);
export const paddingEach = (edges: Dimensions): Modifier => mod("Padding", edges);
export const background = (color: ColorToken, shape?: Shape): Modifier => mod("Background", props({ color, shape }));

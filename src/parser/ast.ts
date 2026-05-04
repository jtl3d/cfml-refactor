export interface Range {
  start: number;
  end: number;
}

export type CFMLNode = TagNode | ScriptNode | ContentNode | CommentNode;

export interface TagNode {
  type: "tag";
  name: string;
  attributes: Map<string, AttributeValue>;
  selfClosing: boolean;
  range: Range;
  openTagRange: Range;
  closeTagRange?: Range;
  children: CFMLNode[];
}

export interface ScriptNode {
  type: "script";
  range: Range;
  bodyRange: Range;
  body: string;
}

export interface ContentNode {
  type: "content";
  range: Range;
  text: string;
}

export interface CommentNode {
  type: "comment";
  range: Range;
  text: string;
}

export interface AttributeValue {
  raw: string;
  value: string;
  hasInterpolation: boolean;
  range: Range;
}

export interface CFMLDocument {
  source: string;
  children: CFMLNode[];
}

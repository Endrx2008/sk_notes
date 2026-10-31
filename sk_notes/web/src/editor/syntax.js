// Lezer Markdown extensions for sk_notes syntax: [[wikilinks]], ![[embeds]], #tags,
// ==highlights==, %%comments%%, $inline math$, $$block math$$, ^block-ids.

import { tags as t, Tag, styleTags } from '@lezer/highlight';

export const skTags = {
  wikilink: Tag.define(),
  wikilinkMark: Tag.define(),
  embed: Tag.define(),
  tag: Tag.define(),
  highlight: Tag.define(),
  comment: Tag.define(t.comment),
  math: Tag.define(),
  blockId: Tag.define(),
};

const BRACKET = 91; // [
const CLOSE = 93; // ]
const BANG = 33; // !
const HASH = 35; // #
const EQ = 61; // =
const PCT = 37; // %
const DOLLAR = 36; // $
const CARET = 94; // ^

const WikiLink = {
  defineNodes: [
    { name: 'WikiLink', style: skTags.wikilink },
    { name: 'Embed', style: skTags.embed },
    { name: 'WikiLinkMark', style: skTags.wikilinkMark },
    { name: 'WikiLinkTarget' },
    { name: 'WikiLinkAlias' },
  ],
  parseInline: [{
    name: 'WikiLink',
    before: 'Link',
    parse(cx, next, pos) {
      let start = pos;
      let embed = false;
      if (next === BANG) {
        if (cx.char(pos + 1) !== BRACKET || cx.char(pos + 2) !== BRACKET) return -1;
        embed = true;
        pos += 1;
      } else if (next !== BRACKET || cx.char(pos + 1) !== BRACKET) return -1;
      let end = -1;
      for (let i = pos + 2; i < cx.end - 1; i++) {
        const c = cx.char(i);
        if (c === 10) return -1;
        if (c === BRACKET && cx.char(i + 1) === BRACKET) return -1;
        if (c === CLOSE && cx.char(i + 1) === CLOSE) { end = i; break; }
      }
      if (end === -1 || end === pos + 2) return -1;
      const inner = cx.slice(pos + 2, end);
      const bar = inner.indexOf('|');
      const children = [cx.elt('WikiLinkMark', start, pos + 2)];
      if (bar === -1) children.push(cx.elt('WikiLinkTarget', pos + 2, end));
      else {
        children.push(cx.elt('WikiLinkTarget', pos + 2, pos + 2 + bar));
        children.push(cx.elt('WikiLinkMark', pos + 2 + bar, pos + 3 + bar));
        children.push(cx.elt('WikiLinkAlias', pos + 3 + bar, end));
      }
      children.push(cx.elt('WikiLinkMark', end, end + 2));
      return cx.addElement(cx.elt(embed ? 'Embed' : 'WikiLink', start, end + 2, children));
    },
  }],
};

const TAG_CHAR = /[^\s!"#$%&'()*+,.:;<=>?@[\\\]^`{|}~　-〿！-／]/u;
const Hashtag = {
  defineNodes: [{ name: 'Hashtag', style: skTags.tag }],
  parseInline: [{
    name: 'Hashtag',
    parse(cx, next, pos) {
      if (next !== HASH) return -1;
      const prev = pos > cx.offset ? cx.slice(pos - 1, pos) : ' ';
      if (/[\p{L}\p{N}_#/&]/u.test(prev)) return -1;
      let end = pos + 1;
      while (end < cx.end) {
        const ch = cx.slice(end, end + 1);
        if (!TAG_CHAR.test(ch)) break;
        end++;
      }
      const body = cx.slice(pos + 1, end).replace(/\/+$/, '');
      if (!body || /^[\d/]+$/.test(body)) return -1;
      return cx.addElement(cx.elt('Hashtag', pos, pos + 1 + body.length));
    },
  }],
};

function delimited(name, markName, code, len, style) {
  return {
    defineNodes: [{ name, style }, { name: markName, style: t.processingInstruction }],
    parseInline: [{
      name,
      before: 'Emphasis',
      parse(cx, next, pos) {
        for (let i = 0; i < len; i++) if (cx.char(pos + i) !== code) return -1;
        if (cx.char(pos + len) === code) return -1;
        if (cx.char(pos + len) === 32 || cx.char(pos + len) === 10) return -1;
        for (let i = pos + len; i < cx.end - len + 1; i++) {
          if (cx.char(i) === 10 && name !== 'Comment') return -1;
          let ok = true;
          for (let k = 0; k < len; k++) if (cx.char(i + k) !== code) ok = false;
          if (ok && i > pos + len) {
            return cx.addElement(cx.elt(name, pos, i + len, [
              cx.elt(markName, pos, pos + len), cx.elt(markName, i, i + len)]));
          }
        }
        return -1;
      },
    }],
  };
}

const Highlight = delimited('Highlight', 'HighlightMark', EQ, 2, skTags.highlight);
const Comment = delimited('Comment', 'CommentMark', PCT, 2, skTags.comment);

const InlineMath = {
  defineNodes: [{ name: 'InlineMath', style: skTags.math }, { name: 'InlineMathMark', style: t.processingInstruction }],
  parseInline: [{
    name: 'InlineMath',
    before: 'Escape',
    parse(cx, next, pos) {
      if (next !== DOLLAR || cx.char(pos + 1) === DOLLAR || cx.char(pos + 1) === 32) return -1;
      for (let i = pos + 1; i < cx.end; i++) {
        const c = cx.char(i);
        if (c === 10) return -1;
        if (c === DOLLAR && cx.char(i - 1) !== 92 && cx.char(i - 1) !== 32) {
          if (cx.char(i + 1) >= 48 && cx.char(i + 1) <= 57) return -1;
          return cx.addElement(cx.elt('InlineMath', pos, i + 1, [cx.elt('InlineMathMark', pos, pos + 1), cx.elt('InlineMathMark', i, i + 1)]));
        }
      }
      return -1;
    },
  }],
};

const BlockMath = {
  defineNodes: [{ name: 'BlockMath', block: true, style: skTags.math }, { name: 'BlockMathMark', style: t.processingInstruction }],
  parseBlock: [{
    name: 'BlockMath',
    before: 'FencedCode',
    parse(cx, line) {
      if (!line.text.slice(line.pos).startsWith('$$')) return false;
      const start = cx.lineStart + line.pos;
      const rest = line.text.slice(line.pos + 2);
      if (rest.trim().endsWith('$$') && rest.trim().length >= 2) {
        cx.addElement(cx.elt('BlockMath', start, cx.lineStart + line.text.length));
        cx.nextLine();
        return true;
      }
      let end = cx.lineStart + line.text.length;
      while (cx.nextLine()) {
        end = cx.lineStart + line.text.length;
        if (line.text.includes('$$')) { cx.nextLine(); break; }
      }
      cx.addElement(cx.elt('BlockMath', start, end));
      return true;
    },
  }],
};

const CommentBlock = {
  defineNodes: [{ name: 'CommentBlock', block: true, style: skTags.comment }],
  parseBlock: [{
    name: 'CommentBlock',
    before: 'FencedCode',
    parse(cx, line) {
      const txt = line.text.slice(line.pos);
      if (!txt.startsWith('%%')) return false;
      const rest = txt.slice(2);
      if (rest.includes('%%')) return false; // inline comment, handled inline
      const start = cx.lineStart + line.pos;
      let end = cx.lineStart + line.text.length;
      while (cx.nextLine()) {
        end = cx.lineStart + line.text.length;
        if (line.text.includes('%%')) { cx.nextLine(); break; }
      }
      cx.addElement(cx.elt('CommentBlock', start, end));
      return true;
    },
  }],
};

const BlockId = {
  defineNodes: [{ name: 'BlockId', style: skTags.blockId }],
  parseInline: [{
    name: 'BlockId',
    parse(cx, next, pos) {
      if (next !== CARET) return -1;
      if (pos > cx.offset && cx.char(pos - 1) !== 32) return -1;
      let end = pos + 1;
      while (end < cx.end && /[A-Za-z0-9-]/.test(String.fromCharCode(cx.char(end)))) end++;
      if (end === pos + 1) return -1;
      // only at the end of the line
      for (let i = end; i < cx.end; i++) { const c = cx.char(i); if (c === 10) break; if (c !== 32) return -1; }
      return cx.addElement(cx.elt('BlockId', pos, end));
    },
  }],
};

export const skMarkdownExtensions = [WikiLink, Hashtag, Highlight, Comment, InlineMath, BlockMath, CommentBlock, BlockId,
  { props: [styleTags({ WikiLinkTarget: skTags.wikilink, WikiLinkAlias: skTags.wikilink })] }];

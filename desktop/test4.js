import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';
import { JSDOM } from 'jsdom';
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>');
global.window = dom.window;
global.document = dom.window.document;
global.HTMLElement = dom.window.HTMLElement;

const e = new Editor({
  extensions: [
    StarterKit.configure({ link: { openOnClick: false }, paragraph: false, heading: false }),
    Markdown,
  ]
});

const schema = e.schema;
try {
  e.chain().insertContent('<a href=\"http://a.com\">test</a>').run();
  console.log('INSERT_HTML_OK');
} catch (err) {
  console.log('INSERT_HTML_ERROR:', err.message);
}

try {
  const node = schema.text('test ', [schema.marks.link.create({ href: 'http://a.com' })]);
  e.view.dispatch(e.state.tr.replaceSelectionWith(node, false));
  console.log('REPLACE_NODE_OK');
} catch(err) {
  console.log('REPLACE_NODE_ERROR:', err.message);
}

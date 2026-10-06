import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Color } from '@tiptap/extension-text-style';
import { Markdown } from '@tiptap/markdown';

// Mock browser environment for Tiptap
import { JSDOM } from 'jsdom';
const dom = new JSDOM('<!DOCTYPE html><html><body><div id="editor"></div></body></html>');
global.document = dom.window.document;
global.window = dom.window;
global.HTMLElement = dom.window.HTMLElement;
global.Node = dom.window.Node;
global.Element = dom.window.Element;
global.navigator = dom.window.navigator;

const editor = new Editor({
  element: document.querySelector('#editor'),
  extensions: [
    StarterKit.configure({ link: { openOnClick: false }, paragraph: false, heading: false }),
    // Mock AlignedParagraph
    require('@tiptap/extension-paragraph').Paragraph.extend({ name: 'paragraph' }),
  ],
  content: '<p>Test paragraph</p>'
});

try {
  const linkNode = { type: "text", text: "dummy.pdf ", marks: [{ type: "link", attrs: { href: "/api/notes/image/dummy.pdf" } }] };
  editor.chain().focus().insertContent(linkNode).run();
  console.log("Success! HTML:", editor.getHTML());
} catch(e) {
  console.error("Crash!", e.message, e.stack);
}

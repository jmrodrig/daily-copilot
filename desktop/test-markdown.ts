import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from 'tiptap-markdown';

const editor = new Editor({
  content: 'Hello<p></p>',
  extensions: [
    StarterKit,
    Markdown,
  ]
});

console.log('OUTPUT:', JSON.stringify(editor.storage.markdown.getMarkdown()));

editor.commands.setContent('Hello<p></p><p>World</p>');
console.log('OUTPUT2:', JSON.stringify(editor.storage.markdown.getMarkdown()));

editor.commands.setContent('<p>Hello</p><p></p><p></p>');
console.log('OUTPUT3:', JSON.stringify(editor.storage.markdown.getMarkdown()));

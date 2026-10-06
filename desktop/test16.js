import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';

try {
  const editor = new Editor({ 
    extensions: [StarterKit], 
    content: '<p>Hello</p>' 
  });
  
  editor.chain().focus('end').insertContent('<a href="url">name</a>&nbsp;').run();
  console.log("Success");
  console.log("HTML:", editor.getHTML());
} catch(e) {
  console.error("Error:", e);
}

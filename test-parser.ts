import { isLanguageAvailable, loadParser } from './src/core/tree-sitter/parser-loader.js';

async function main() {
  const langs = ['Go', 'Python', 'TypeScript', 'JavaScript', 'PHP', 'Rust'];
  for (const lang of langs) {
    const available = isLanguageAvailable(lang);
    console.log(`isLanguageAvailable(${lang}): ${available}`);
  }

  console.log('---');

  // Test loadParser for Go
  const parser = await loadParser('Go');
  console.log(`loadParser(Go): ${parser ? 'OK' : 'FAILED'}`);

  if (parser) {
    const tree = parser.parse('package main\n\nfunc hello() {\n  fmt.Println("hello")\n}\n');
    console.log(`Parse: ${tree.rootNode.type}, children: ${tree.rootNode.childCount}`);
    for (const child of tree.rootNode.children) {
      console.log(`  - ${child.type}: ${child.text.substring(0, 50)}`);
    }
  }

  // Test loadParser for Python
  const pyParser = await loadParser('Python');
  console.log(`loadParser(Python): ${pyParser ? 'OK' : 'FAILED'}`);

  if (pyParser) {
    const tree = pyParser.parse('def hello():\n    print("hello")\n\nclass Foo:\n    pass\n');
    console.log(`Parse: ${tree.rootNode.type}, children: ${tree.rootNode.childCount}`);
    for (const child of tree.rootNode.children) {
      console.log(`  - ${child.type}: ${child.text.substring(0, 50)}`);
    }
  }
}

main().catch(console.error);

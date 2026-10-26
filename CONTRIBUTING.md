# Contributing to Git Tree

Git Tree is a TypeScript extension for Visual Studio Code. Its layout follows Git Graph's:

* `src/` holds the extension. `dataSource.ts` runs Git, and `gitGraphView.ts` answers the messages the view sends.
* `web/` holds the view that runs in the webview. `main.ts` renders the graph, menus and dialogs.
* `src/types.ts` defines the messages between the two.
* `tests/` holds the Jest tests.

## Building and testing

```sh
npm install
npm run compile   # lint, then build ./out and ./media
npm test
```

To run the extension, open this folder in Visual Studio Code and press F5. That starts an Extension Development Host with Git Tree loaded.

## Line endings

The source files use CRLF line endings, as Git Graph's do, and the linter checks this. Keep them when you edit a file.

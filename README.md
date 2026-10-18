# IDSL Editor — LaTeX + Typst

A local workspace for writing LaTeX and Typst, with a project explorer, source editing, live Typst preview, and LaTeX PDF preview. Run it on your Mac or host it for a small research group.

## Screenshots

![Classic LaTeX article with source and compiled PDF](docs/images/workspace.png)

| Project explorer | Dark theme |
| --- | --- |
| [![Project explorer with LaTeX and Typst documents](docs/images/projects.png)](docs/images/projects.png) | [![Dark Typst editor](docs/images/dark-theme.png)](docs/images/dark-theme.png) |

More views: [LaTeX autocomplete](docs/images/latex-autocomplete.png) · [Folder actions](docs/images/folder-actions.png) · [Source folding](docs/images/source-folding.png) · [Multiple file selection](docs/images/file-selection.png) · [Source editing](docs/images/source-editor.png) · [Live Typst + LSP](docs/images/typst-live.png) · [Typst](docs/images/typst-workspace.png) · [Template library](docs/images/template-library.png) · [Image preview](docs/images/image-preview.png) · [File actions](docs/images/file-actions.png) · [Account menu](docs/images/account-menu.png) · [Themes](docs/images/themes.png) · [Western slides](docs/images/western-presentation.png) · [NeurIPS paper](docs/images/neurips-paper.png) · [Project actions](docs/images/project-actions.png) · [Project list](docs/images/projects-list.png) · [Mobile](docs/images/projects-mobile.png) · [Sharing](docs/images/sharing.png) · [GitHub backups](docs/images/github-backups.png).

All screenshots use a temporary database, fictional demo accounts, and starter documents. They contain no real projects, credentials, or usable invitation links.

## Features

- **Project explorer:** organize projects into nested folders; use **⋯** to download a project's source ZIP, duplicate, rename, move, or delete it, or drag it onto a folder. Deleted projects stay in **Trash** for 30 days. Cards/list, search, sorting, and format/ownership filters help you find documents. **My projects** saves and opens the root projects view.
- **Focused workspace:** full-height source and preview, foldable sections/slides/code blocks, smart Enter indentation, Tab/Shift+Tab for selected lines, a collapsible file explorer (**Ctrl/Cmd+B**), and a compact **Project ⋯** menu for secondary controls.
- **LaTeX + Typst:** source editing, multi-file projects with collapsible folders, image previews (including SVG), right-click actions, figures, and bibliographies. Select multiple files with Cmd/Ctrl-click or Shift-click to delete them together; folders can be deleted with their contents. Right-click a folder or empty space to create files, persistent empty folders, or upload assets there; click the editor’s project title to rename it in place.
- **Live Typst on Mac:** Tinymist keeps an incremental compiler running, streams preview updates while typing, and provides autocomplete, documentation, go-to-definition, formatting, diagnostics, and source/preview navigation.
- **Code autocomplete:** suggestions appear while typing in LaTeX and Typst. Use **Ctrl+Space**, arrows, and **Tab/Enter** to insert commands/snippets; LaTeX also completes environments, project citation keys, labels, and file paths. Typst uses Tinymist when connected and local suggestions otherwise.
- **PDF preview + export:** click LaTeX or Typst preview text to open its source; automatic LaTeX builds, clickable errors, project-named PDF/ZIP downloads, and an independent dark-preview toggle.
- **Sharing:** invite coauthors to individual projects with editor or view-only access.
- **Autosave + history:** recover browser drafts, restore saved file versions, and detect conflicting edits.
- **GitHub backups:** keep all projects in named folders in one repository or use a separate repository per document; saved tokens, a one-click global backup button beside the explorer theme toggle, and optional backups after saving while the tab is open. [Setup →](docs/LOCAL.md#github-backups)
- **Import/export:** import project ZIPs (including Overleaf exports), upload assets, and download complete source ZIPs.
- **Themes:** choose IDSL Forest, Western Purple, Nord, GitHub, or Solarized under **Account → Themes & appearance**; switch light/dark with one click on the sun/moon button.
- **Ready-to-use templates:** Western slides and NeurIPS are featured; **More templates** offers a Typst introduction, classic LaTeX article, Western thesis scaffold, coursework, Beamer slides, and academic CV.

Templates create private, editable copies only when you choose one.

## Quick start on macOS

**Requires Python 3.10+** on Apple Silicon or Intel. Check with `python3 --version`; install Python from [python.org](https://www.python.org/downloads/macos/) if needed. Git is needed for cloning; you can also [download the source ZIP](https://github.com/niruhan/idsl-latex/archive/refs/heads/main.zip).

```sh
git clone https://github.com/niruhan/idsl-latex.git
cd idsl-latex
./labtex setup
./labtex start
./labtex setup-token
```

1. Open **[http://127.0.0.1:8765](http://127.0.0.1:8765)**.
2. Use the printed setup token to create your account and choose a password.
3. Choose a featured starter, open **More templates**, or use **New project**.

Setup installs and checks Typst, Tectonic, and Tinymist inside this checkout. No Docker, Node.js, or full TeX installation is required. The first setup/build needs internet access.

Upgrading an existing installation? Run `./labtex stop`, `./labtex setup`, then `./labtex start` to enable Tinymist.

Use `./labtex stop` to stop and `./labtex start` to return later. Already cloned? Skip the clone step. For a source ZIP, use `python3 labtex` in place of `./labtex` if executable permissions were lost. [Full Mac guide →](docs/LOCAL.md)

## Install on Linux

Shared hosting requires x86_64 Linux, Python 3.10+, systemd, cgroup v2, and Bubblewrap. Follow the **[Linux installation guide](docs/INSTALL_LINUX.md)** for prerequisites, setup, invitations, and optional HTTPS access. The Mac runner is for personal, local use.

## Guides

| Need | Guide |
| --- | --- |
| Mac setup, themes, editor, GitHub backup/restore | [Local guide](docs/LOCAL.md) |
| Shared Linux installation | [Linux setup](docs/INSTALL_LINUX.md) |
| SSH access, HTTPS, reverse proxies | [Hosting](docs/HOSTING.md) |
| Database backups, updates, account recovery | [Operations](docs/OPERATIONS.md) |
| Tests and screenshot generation | [Development](docs/DEVELOPMENT.md) |
| Privacy and isolation boundaries | [Security](SECURITY.md) |

Projects/accounts stay in ignored `data/`; compilers, caches, and setup tokens stay in ignored `.local/`. Keep those directories private when committing or sharing source.

**Disclaimer:** This project was vibecoded with Codex. Review and test it for your needs before relying on it.

MIT licensed. See [LICENSE](LICENSE) and [third-party licenses](THIRD_PARTY.md).

# IDSL Lab — LaTeX + Typst

A local workspace for writing LaTeX and Typst, with a project explorer, visual/source editing, and a PDF preview. Run it on your Mac or host it for a small research group.

## Screenshots

![Typst editor with source and compiled PDF](docs/images/typst-workspace.png)

| Project explorer | Dark theme |
| --- | --- |
| [![Project explorer with LaTeX and Typst documents](docs/images/projects.png)](docs/images/projects.png) | [![Dark Typst editor](docs/images/dark-theme.png)](docs/images/dark-theme.png) |

More views: [LaTeX](docs/images/workspace.png) · [Visual editor](docs/images/visual-editor.png) · [Themes](docs/images/themes.png) · [Western slides](docs/images/western-presentation.png) · [NeurIPS paper](docs/images/neurips-paper.png) · [Project list](docs/images/projects-list.png) · [Mobile](docs/images/projects-mobile.png) · [Sharing](docs/images/sharing.png) · [GitHub backups](docs/images/github-backups.png).

All screenshots use a temporary database, fictional demo accounts, and starter documents. They contain no real projects, credentials, or usable invitation links.

## Features

- **Project explorer:** organize projects into nested folders; move them with the arrow button or drag and drop. Cards/list, search, sorting, and format/ownership filters help you find documents. **My projects** saves and returns home.
- **LaTeX + Typst:** source and basic visual editing, multi-file projects with collapsible folders, figures, and bibliographies.
- **PDF preview:** manual or automatic compilation, clickable error locations, and PDF download.
- **Sharing:** invite coauthors to individual projects with editor or view-only access.
- **Autosave + history:** recover browser drafts, restore saved file versions, and detect conflicting edits.
- **GitHub backups:** keep all projects in one repository or use a separate repository per document; optional backups after saving while the tab is open. [Setup →](docs/LOCAL.md#github-backups)
- **Import/export:** import project ZIPs (including Overleaf exports), upload assets, and download complete source ZIPs.
- **Themes:** choose IDSL Forest, Western Purple, Catppuccin, Dracula, or Solarized from **Themes**; switch light/dark with one click on the sun/moon button.
- **Ready-to-use templates:** start a private copy of the Western Typst presentation or NeurIPS 2026 LaTeX paper, including its official style and checklist.

Visual mode supports basic headings, paragraphs, emphasis, and Typst lists. Advanced equations/templates remain editable in source cards. The Typst sample belongs to your account; repeat visits preserve edits and avoid duplicates.

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
3. Click **Open sample**, choose a starter under **Start with a template**, or use **New project**.

Setup installs and checks both compilers inside this checkout. No Docker, Node.js, or full TeX installation is required. The first setup/build needs internet access.

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

MIT licensed. See [LICENSE](LICENSE) and [third-party licenses](THIRD_PARTY.md).

# Denotation — User Guide

This guide covers everything from opening Denotation for the first time to building your own databases. For a short introduction, see the [README](README.md).

Denotation is a personal workspace that runs entirely in your browser: pages made of blocks, databases with many kinds of views, formulas, and a few tools to keep it all tidy. There is no account and no server.

**Contents**

1. [Running Denotation](#1-running-denotation)
2. [Finding your way around](#2-finding-your-way-around)
3. [Writing pages](#3-writing-pages)
4. [Databases](#4-databases)
5. [Formulas](#5-formulas)
6. [Feedback](#6-feedback)
7. [Your data](#7-your-data)
8. [Appearance](#8-appearance)
9. [Keyboard shortcuts](#9-keyboard-shortcuts)
10. [Troubleshooting](#10-troubleshooting)

---

## 1. Running Denotation

### A. Run it on your computer

You need Node.js (for `npm`) and Python 3 (it acts as a tiny web server).

1. Open a terminal in the project folder.
2. Run:

   ```
   npm start
   ```

3. Open **http://localhost:8080** in your browser.

To stop it, press Ctrl+C in the terminal. Your pages stay in the browser and will be there next time.

> **Open it over `http://`, not as a file.** Double-clicking `source/app/index.html` will not work, because browsers refuse to run the app's code straight from a folder. Always use the address above.

> **Keep the same address.** Your workspace belongs to one exact address, port included. If you open `http://localhost:8080` one day and `http://127.0.0.1:8080` the next, each one looks like a brand new, empty workspace. Pick one and stick with it.

### B. Install it as an app

Denotation is published on GitHub Pages (`https://<user>.github.io/<repo>/`; the repository root forwards to the app in `source/app/`), so you can use it straight from the web address, with nothing to install and no account.

- **Try it first.** Just open the address and use it in a tab; installing is optional and keeps the same data.
- **Install.** Open **⋯ → Install app**. Where the browser allows it (Chrome, Edge, Android) its install dialog opens; otherwise it tells you where to find install in your browser menu. **⋯ → Settings → App** shows the same, plus the version. On iPhone and iPad, tap **Share → Add to Home Screen**. An installed app has its own window and icon.
- **Offline.** After the first visit the whole app is saved on your device, so it opens and works with no connection. Your data stays on your device (or in the folder you chose) either way.
- **Updates.** When a new version is published, an **Update available · Reload** message appears. Pending edits are saved first, then the app reloads on the new version. Nothing changes until you tap Reload.
- **Keeping your data.** The app asks the browser to keep its data. Safari may still clear it after about 7 days without use unless the app is added to the Home Screen.

### C. Inside a Claude artifact

If the app is opened as a Claude artifact, it saves your workspace to Claude's own storage instead of your browser. The sidebar footer always says where your data is going (see [section 7](#7-your-data)).

---

## 2. Finding your way around

### The sidebar

The sidebar is on the left. From top to bottom:

| Part | What it does |
|---|---|
| **New** button | Opens a menu to create a page, database, sheet, or a database from a CSV file |
| Search icon | Opens quick find |
| Close icon | Close the sidebar when it is unlocked |
| **⋯** (workspace menu) | Everything that applies to the whole workspace: **Settings** ([Appearance](#8-appearance)), **[Feedback](#6-feedback)**, **Trash**, **Archive**, **Lock sidebar open** / **Unlock sidebar** (wide screens), **Install app**, **Export ▸**, **Import ▸**, **Storage…** (Chrome or Edge, plus **Pull** / **Push** when a main location is connected) and **AI access…** |
| **Favorites** | Pages you starred (only shown when you have some) |
| **Repositories** | Your top-level folders, with their pages nested underneath |
| Footer | Where your data is stored (this browser, or the connected folder) |

On a wide screen the sidebar is **locked open** by default. Unlock it from **⋯ → Unlock sidebar** (and lock it again with **⋯ → Lock sidebar open**) if you want more room; its width stays the same either way: it then slides in over the page when you open it, and out of the way when you pick a page. On a phone it starts closed, and a small button on the left edge opens it. **Ctrl/Cmd + \\** also opens and closes the sidebar once it is unlocked.

### On a phone or tablet

Denotation works on phones and tablets too:
- The sidebar slides in over the page: the button at the top left opens it, and tapping outside closes it. (Locking it open only applies on wide screens.)
- **Long-press** a page in the sidebar for its menu (the same as right-click).
- Tap a block (or long-press it) and use its **≡ handle** for its options, including **Move up** and **Move down**.
- On a board, each card has a **Move to…** button. In a sheet, tap a selected cell again to edit it.
- Dialogs open as sheets from the bottom of the screen, above the keyboard.
- On iPhone and iPad, **Share → Add to Home Screen** gives the best experience.

Folders and storage locations need Chrome or Edge on a computer. On a phone, use ZIP export and import to move your workspace.

### Repositories, pages and databases

- A **repository** is a top-level container, like a notebook or a project folder. A new workspace starts with one called "My repository", holding a welcome page and a small example database.
- A **page** holds blocks of content. Pages can contain **sub-pages**, as deep as you like. Click the small arrow beside a name to fold or unfold what is inside.
- A **database** holds rows of structured data. See [section 4](#4-databases).
- Click a repository's name to see its contents as cards, with **New page**, **New database** and a **More** menu.

Create something new with the **New** button in the sidebar. It adds to the repository you are currently in. The menu offers:

- **Page**
- **Database** and **Sheet** (listed under *Original source*)
- **Database from CSV…**
- **From template…** (makes a new page from one of your [templates](#templates))
- **Database view of…** and **Sheet view of…** (listed under *View of an existing source*, see [linked views](#linked-views))

Use the **+** beside **Repositories** to create a new repository.

### The page menu (right-click, long-press or Shift+F10)

Every item in the sidebar has its own menu:

- **Desktop:** right-click it.
- **Phone or tablet:** press and hold it for about half a second.
- **Keyboard:** Tab to the item and press **Shift+F10** (or the Menu key). This uses your browser's standard context-menu key, so it can depend on your system.

The menu has **Open**, **Add sub-page** (or **Add page or database** on a repository), **Rename**, **Add to favorites** / **Remove from favorites**, **Duplicate**, **Archive** and **Move to trash**.

When you are on a page, the **⋯ Page options** button at the top has more: change icon, **Full width**, **Small text**, **Lock page**, **Duplicate**, **Move to** another page or repository, **Export as Markdown**, **Add a property**, **Automatic callouts…**, **Template** (and **Template for ▸** on a template), **Archive** and **Move to trash**. On a database it also has **Row pages**, **New row template** and **New row from template ▸**. Beside it is a star to add the page to your favorites. You can also add an icon and a cover (a choice of eight gradients) from the top of the page.

The breadcrumb at the top shows where you are; click any part to go back up.

### Quick find

Press **Ctrl/Cmd + K** (or click **Search**) and start typing. It searches page titles, page text, page properties and database rows. Tick **Include archived** to search the [Archive](#archive) too. Press **Enter** to open the first result, or click any result.

### Favourites

Star a page with the star at the top of the page, or choose **Add to favorites** from its menu. It then appears under **Favorites** at the top of the sidebar. Repositories cannot be favourited.

### Trash

**Move to trash** hides a page everywhere else, but nothing is gone yet. Open **Trash** in the sidebar to:

- **Restore** a page, or
- **Delete forever** (it asks first), or
- **Empty trash** to clear everything.

Trashing a page also hides the pages inside it. Deleting a database row from its page asks for confirmation and removes it permanently, with no trash step.

### Archive

**Archive** (page menu) puts a page away without deleting it. It leaves the page tree, search and pickers, and becomes read-only. Open **Archive** from the workspace **⋯** menu to **Restore** a page (it goes back where it was, or to the top of its repository if that place is gone) or **Move to trash**. A row body archived from a database shows a link back to its row.

### Properties

Any page or database can have properties under its title: text, number, date, select, multi-select, checkbox, URL or a link to another page. Add one with **Add a property** (page **⋯** menu, or the link under the list). Click a property's name (or right-click it, or press Shift+F10) to edit, move or delete it. Click **Properties** to fold the list. Database rows use their columns as properties.

### Templates

Mark a page as a template with **Template** in its **⋯** menu. It moves out of the page tree into the repository's folded **Templates** group in the sidebar. **New → From template…** makes a new page with a copy of the template's blocks, properties and automatic callouts; the template itself is unchanged.

For a database, **⋯ → New row template** makes a template whose properties match the columns. **New row from template** (**⋯** menu, or **From template** next to New row) adds a row with those values and the template's body. **Template for ▸** switches a template between new pages and rows of a database. Only pages (not databases) can be templates.

---

## 3. Writing pages

### Blocks

A page is a stack of **blocks**: paragraphs, headings, lists and so on. Click anywhere in a block to write in it. Each block has a **handle** (three lines) out in the left margin. It shows on the line you are editing or last tapped, and with a mouse also on the hovered block. Text keeps an equal margin on the left and right.

- **Click the handle** for the block menu, or right-click any block (long-press on a touch screen, Shift+F10 / the Menu key while it's focused), including tables, images, code, pivot tables and database views. Every block's settings live in this menu instead of a bar on the page. While you're editing text, on links or on selected text, right-click still shows your browser's own menu. On a locked page the menu offers only view options, such as Copy code and the graph's Graph/List switch.
- **Drag the handle** to move the block, even into a column or another position in a list.

The block menu has:

- **Turn into**: change the type of the block.
- **Color**: a text colour (Default or one of 12 hues) and a background (Default, 12 hues or Grey). Grey is background only. The current choice shows a check mark, and colours adapt to light, neutral and dark mode. Older pages keep their look as closely as possible: old colour names map to the nearest hue, and old grey text becomes default.
- **Make foldable** on headings (turns it into a toggle heading).
- **Column count** on a columns block.
- **Duplicate**, **Copy**, **Cut**, **Paste below**, **Move up**, **Move down**.
- **Move to page** (sends the block to another page).
- **Copy link**, **Turn into synced block**, **Delete**.

At the very end of a page there is an empty strip: click it to add one more block at the end.

### The insert menu: type `/`

In an empty line, or after a space, type **/** and a menu of blocks appears. Keep typing to narrow it down ("/head", "/todo"). Use the arrow keys and **Enter**, or click an item.

Some blocks take a size: type `/table 4x5` for a four-row, five-column table, or `/columns 3` for three columns.

| Group | Blocks |
|---|---|
| **Basic** | Text, Heading 1 to 4, Bulleted list, Numbered list, To-do list, Toggle list, Toggle headings 1 to 4, Quote, Callout, Code, Divider |
| **Layout** | Table, 2 to 5 columns |
| **Media** | Image, Web bookmark |
| **Advanced** | Table of contents, Breadcrumb, Pivot table, Synced block |
| **Pages** | Page, Database (a new sub-page or sub-database, linked right here) |

### Mention a page: type `@`

Type **@** and a few letters of a page's title. Pick it from the list and a link to that page is inserted into your text. Click the link to jump there.

### Markdown shortcuts

At the start of an empty paragraph, type one of these and the block changes as soon as you press the space (or the final character):

| Type | You get |
|---|---|
| `# `, `## `, `### `, `#### ` | Heading 1, 2, 3, 4 |
| `- `, `* ` or `+ ` | Bulleted list |
| `1. ` | Numbered list |
| `[] ` or `[x] ` | To-do (the second one starts checked) |
| `> ` | Toggle list |
| `" ` | Quote |
| `---`, `***` or `___` | Divider |
| ` ```js ` (three backticks, optionally a language) | Code block |

Inside text, markdown works too: `**bold**`, `*italic*` or `_italic_`, `~~strikethrough~~`, `` `code` `` and `[label](https://address)` links. While you are editing, you see the raw characters; click away and they turn into formatting. To type a special character literally, put a backslash in front of it.

You can also **paste markdown** with several lines and it becomes proper blocks. **Pasting an image** from the clipboard inserts an image block.

### Block types

**Headings, lists and to-dos.** Heading 1 to 4. To-dos have a checkbox; **Ctrl/Cmd + Enter** ticks it. Numbered lists renumber themselves.

**Toggles and nesting.** A toggle list folds away what is inside it. Press **Tab** to nest a block under the one above it, **Shift+Tab** to bring it back out. Any heading can also be made foldable from its handle menu, or by choosing a *Toggle heading* from `/`. **Ctrl/Cmd + Enter** folds or unfolds the block you are in.

**Callout.** A highlighted note with an icon. Click the icon to choose a preset (Info, Tip, Note, Success, Warning, Danger, Question, Quote), or **Custom icon…**. A custom icon or colour (handle menu → **Color**) changes only that callout; **Reset to preset** undoes it. Callouts made before presets keep their look. (There is no markdown shortcut; use `/callout`.)

**Automatic callouts.** Page **⋯ → Automatic callouts…** sets rules such as "When Status is Draft, show Warning: Draft, not reviewed yet". Conditions: is, is not, is empty, is not empty, contains, is before, is after (dates, numbers, or "today"). Rules on a page also apply to its sub-pages; rules on a database apply to its row pages; rules on a template are copied into pages made from it. The nearest page with rules wins. Matching callouts appear at the top, marked "automatic", and change as properties change. **Pin as block** turns one into a normal callout.

**Quote.** A quoted passage. Colours work here too.

**Code.** Monospaced text, with **Language** (plain, js, ts, python, json, html, css, bash, sql, java, c, go, rust, markdown) and **Copy code** in the block menu. The language shows quietly in the top-right corner. Enter adds a new line inside it; **Ctrl/Cmd + Enter** leaves the block and starts a new paragraph below. Tab inserts two spaces.

**Table.** A grid you type straight into. Controls under the table set the number of **Rows** (up to 100) and **Columns** (up to 12), and whether the first row and first column are headers. This is a simple text table; for data you want to sort, filter or calculate, use a [database](#4-databases).

**Tables.** Right-click or long-press a cell (or press Shift+F10 in it, or use the handle) for the table menu: **Header row**, **Header column**, **Row N** (add above, add below, delete, height…, reset height), **Column N** (add left, add right, delete, width…, reset width), **Rows…** and **Columns…** for an exact size, **Reset sizes** and **Use as data source**. Row and column actions apply to the cell you opened the menu on. Headers are bold with a heavier line. Drag the right edge of a top-row cell to change a column's width, or the bottom edge of a first-column cell to change a row's height (double-click to reset). Sizes use px, em or rem; a bare number means px. A table used as a data source always reads its first row as column names.

**Columns.** Two to six side-by-side columns. Each is a mini-page of its own: drag blocks into and between them with the handle. Change the count from the block's handle menu.

**Image.** Choose **Upload image** (pictures are shrunk to fit), or paste a link with **Embed link**. Add a caption underneath. You can also paste an image straight in. If an image from another website won't load, upload the file instead.

**Image size.** The block menu has **Image size…**, **Replace image…** and **Align** (left, centre, right). Width and height take px, em or rem (a bare number is px) or the name of a repository constant, so changing that constant resizes every image that uses it. A constant must hold a number (px) or text like `20em`; otherwise the image shows at its natural size and a note says why. Width alone keeps the proportions; setting both stretches it. On the selected image, drag the right edge, bottom edge or corner (corner keeps proportions) to resize by hand.

**Inline images.** Type `/Inline image` to place a small picture inside a line of text, with a link or an upload (shrunk to about 150 KB), alt text and an optional width/height. Markdown export writes images as `![alt](src)` without size.

**Math.** Type `/Inline math` for a formula inside a line, or `/Math block` for a display equation. Click a formula (or press Enter on it) to edit: type LaTeX, watch the live preview, and use the **Symbols** palette for fractions, roots, sums, integrals, Greek letters, arrows and matrices. Esc or a click outside saves; **Cancel** restores. Mistakes show as "Math error" with the reason. Markdown export writes `$…$` and `$$ … $$`, and importing Markdown turns them back into formulas (prices like `$5` are left alone). Rendered offline with KaTeX.

**Function graph.** `/Function graph` adds a graph block; `/Inline function graph` puts a small graph in a line of text. Click it (or press Enter) to edit: write functions of `x` (for example `sin(x)`, `x^2 - 3`, `2x + 1`) using `pi`, `e`, your repository constants and formula functions such as SIN, COS, TAN, SQRT, ABS, LN, EXP and IF; set the x range and optionally the y range (empty means automatic); add labelled points. Each function has a colour and is listed as `y = …` under the graph (every second line is dashed). Gaps such as `1/x` at 0 or `tan` at its asymptotes are left open. The block menu has **Edit graph**, **Hide grid** and **Automatic y range**. Note: `-x^2` reads as `(-x)^2`; write `-(x^2)`.

**Flowchart** (`/flowchart`). Draws boxes and arrows. Placement is automatic; steer it from the block menu (≡ handle, right-click or long-press the chart): **Layout** (Flow, Cycle, Tree, Row, Grid), **Direction** (down, up, right, left), **Rotation** and **Turn** (cycle only) and **Spacing**. **Edit flowchart…** edits it as text or with lists of boxes and connections. Click a box for its own menu: rename, shape, colour, connect, move earlier/later, delete. Box order sets the order of siblings and around a cycle. Shapes: rect, rounded, pill, diamond, circle, parallelogram, cylinder, document; colours: the 12 hues or grey. Each box has two colours in its menu: **Outline and text colour** and **Fill** (12 hues, grey or none; quick syntax `A [blue bg=yellow]: text`). Connection labels move out of the way of boxes, and in a Grid layout connections bend around boxes. To link to a box, right-click it and choose **Copy link to box**, or type `[[Page title#box-id]]` (the id is the short name before the colon in quick syntax); opening the link scrolls to the chart and highlights the box. Limits: 200 boxes, 400 connections.

Quick text form, one line each: `A -> B: yes` (arrow with a label), `A -- B` (no arrowhead), `A <-> B` (both ends), `A -.-> B` (dashed), `A: some text` (box text), `A [diamond blue]: Ready?` (shape and colour). Lines starting with `#` or `//` are comments. Markdown export writes the chart as a fenced `flow` block, which imports back as a flowchart.

**Web bookmark.** A card showing a link: enter an address and an optional title, then **Save**. Clicking the card opens the link in a new tab; **Edit link…** is in the block menu.

**Table of contents.** A list of all the headings on the page. Click one to jump to it. It updates itself as you add headings.

**Breadcrumb.** Shows the path to this page, as a clickable trail.

**Page.** Creates a sub-page right where you are and drops a link to it. Existing pages can be linked with `@`. Links to a trashed or deleted page say so instead of vanishing.

**Database.** The same, but a new sub-database.

**Synced block.** Turn any block into a synced block from its handle menu. Edits made to it show up everywhere the same synced block is used, which makes it good for something you repeat on many pages, such as a footer or a contact box. Use **Unsync (make independent copy)** to break the connection. A synced block cannot contain itself.

**Pivot table.** A summary of a database inside your page. See below.

### Pivot tables

Insert one with `/pivot`. Then, from the block menu (right-click or long-press the block):

1. **Database:** choose which database to summarise.
2. **Rows:** choose a field to group by. (Select, checkbox, text, date, number, array and dictionary fields work.)
3. **Columns:** optional second field to split by.
4. **Value:** *Count of rows*, or pick a number column.
5. **Calculate:** when a number column is chosen, pick Sum, Average, Min or Max.

Totals for every row and column are shown, and the table updates when the database changes.

### Record preview

Show a few rows from a database right inside a page, looked up by their key.

1. Type `/Record preview` (under Advanced) and pick a database.
2. Type one or more **keys**, the values in the database's key column (the first column unless you change it). Press Enter or a comma after each. Matching ignores capitals and extra spaces.
3. Use **Preview settings…** in the block menu to choose which columns show, their order, width, wrapping, alignment and labels, and whether rows show as a **table** or as **cards** (cards are the default for a single key).

Missing keys say "No row with key …", and keys used by more than one row are marked. Click a row to open it.

**Presets** keep record previews consistent. In Preview settings, **Save as preset…** stores the current display on the database itself. Other blocks can pick it under **Use preset**, and **Edit preset** changes every block that uses it, on every page. **Detach** gives one block its own copy. Deleting a preset leaves each block with a copy of it. Changing the **primary key column** changes it for the database everywhere.

### Inline chips: database values and dates

In any text block, type `/` and choose **Database value** or **Date**, or type `{{`. For a value, pick a database, then the row's key (its primary key, the same one Record preview uses), then a column. The chip shows that cell's current value and updates when you edit the row; click it to open the row. If the database, row or column is gone, the chip says **Not found**. In edit mode you see the raw token, `{{value:<db>|<key>|<column>}}`; Backspace right after a token deletes it whole. Markdown export writes the current value as plain text; Denotation JSON keeps the token.

**Preset chips.** A preset saves a database and column (and optionally a fixed key) so you can drop in the same kind of chip quickly. To make one, type `{{`, pick a database, row and column, then choose **Save as preset…**, name it and optionally tick **Always use this key**. To use one, type `/` and pick **Preset: <name>** (then choose the key), or pick it from the Presets list after `{{`. Editing a preset (name, column, fixed key) updates every chip using it; press the pencil next to it in the `{{` picker. Deleting a preset shows how many chips use it, and those chips then show **Not found**.

### Constants

Right-click a repository in the sidebar and choose **Constants…** to name values you reuse, such as `foundedyear = 2029`. Each constant has a name (letters, digits, `_` and `-`, unique in the repository), a type (text, number or date), a value and an optional format (decimals and thousands separator for numbers, short or long dates).

- In any text block, type `@` and a few letters of the name, then press Enter (or click) to insert it as a chip. Press Escape or keep typing to keep plain text.
- Change the value in the dialog and every chip updates. Renaming keeps existing chips (but formulas that use the old name show `#NAME?`). Deleting asks first and tells you how many chips use it.
- In database formulas use `foundedyear` or `const("foundedyear")`. Databases recalculate when opened.

### More inline chips

Type `/` for:

- **Page chip:** icon and live title; click to open. Also `@` then "… as chip".
- **Checkbox:** click to tick; saved in the text.
- **Status tag:** click to switch status. Edit the list with right-click on the repository → **Statuses…** (default Todo, Doing, Done).
- **Constant.**
- **Inline formula**, for example `{{= 2030 - foundedyear}}`. It can use constants, `value("Database","Key","Column")` and `preset("Preset name","Key")`. Mistakes show a red dashed chip; hover it for the message.

Markdown export writes the resulting text (a checkbox becomes `[x]` or `[ ]`).

### Links, embeds and the graph

Type `[[` to link a page and pick it from the list. The link always shows the page's current title. Start with `x[[` for a **hidden link**, which works the same but draws no line in the graph. `![[` **embeds**: pick a page, then a heading (its section shows inline, read-only) or **Choose blocks…** (up to 12). An embed that would include itself shows a warning instead. Typing `[[Exact title]]` also works. The bottom of every page lists **Linked from**.

Open the **Graph** from the workspace **⋯** menu, or a repository's right-click menu → **Graph**: drag to move, scroll or pinch to zoom, click to open; filter by repository or title, hide unlinked pages, or show every row of chosen databases. The **List** view is a keyboard-friendly alternative. Page **⋯ → Local graph** shows the pages around the current one (1–3 steps). `/graph` adds a graph block. Page **⋯ → Graph appearance** sets a node's icon, colour and size. **Graph → Rules…** (for one repository) styles nodes by property, for example "Status is Done → green". Markdown export writes `[[Title]]`, `x[[Title]]` and `![[Title#Heading]]`.

### Terms

A term is a named word or phrase you define once and reuse as a bold chip. Right-click your repository, choose **Terms…** and press **Add term**. Give it text and, if you like, a short definition, a category and subcategory, a colour and an icon (a Lucide icon or an emoji, shown to the right of the text). In any text, type `@` and start the term's name, or type `/Term`, to insert it. Edit the term once and every chip updates. Hover, focus or tap a chip to read its definition (Esc closes it).

**Categories** group terms in the dialog (category, then subcategory). Under *Category colour and icon* you can give a category a default colour and icon; its terms use them unless they set their own.

**Branches.** A term can be a branch of another: Long Branch and Short Branch under Branch. Use a term's **⋯** menu → **Add branch**, or pick "Branch of" in its editor. Branches take their parent's colour, icon and category unless they set their own, and appear indented under it. Their card says "Branch of Branch" and shows the parent's definition too. A branch can't have its own branches. When you delete a term that has branches, you choose to delete them too or keep them as ordinary terms. The delete prompt shows how many chips use the term. Markdown export writes a term chip as its bold text and drops the definition.

### Locking a page

**Lock page** in the page options makes the whole page read-only: no handles, no typing. Unlock it the same way. Pages in the trash are read-only too.

---

## 4. Databases

A database is a table of **rows**, where every row has the same **columns**. With **Row pages** on (database **⋯** menu), each row also opens as a full page with its own blocks: click the open icon on a row. New databases start with Row pages off: rows are data only, and opening a row shows its values. Databases from before this change keep Row pages on. Turning Row pages off when rows have written content asks whether to **Move to Archive** or **Delete** (to the Trash) those bodies; each becomes a page titled after its row, with the row's values as properties. The rows and their values stay.

Create one from **New → Database**, or **New → Sheet** for a spreadsheet-style start (see views below). The first column is the row's title.

### Columns

Click a column's header to edit it, or click the **+** at the end of the header row to add one. Give it a name and pick a type:

| Type | What it holds |
|---|---|
| **text** | Free text |
| **number** | A number |
| **checkbox** | Yes or no |
| **date** | A date (`YYYY-MM-DD`) |
| **select** | One choice from a list. You type the options, one per line |
| **array** | A list of values of one type (text, number, checkbox or date). Optionally a fixed size, from 1 to 1000 items |
| **dictionary** | Named values. **Strict:** you define the keys and their types. **Loose:** any keys, with text, number or checkbox values |
| **formula** | A calculated value, see [section 5](#5-formulas) |

The type is shown in small print on each header. Changing the type or deleting the column is done from the same editor (deleting asks first, and removes that column's data).

Typed values are checked: a number column will not accept "abc", and a select column only accepts its listed options.

### Views

One database can be shown in many ways at once. The tabs above the data are **views**; click **+** to add another, and use the arrow on the selected tab to **Rename**, **Duplicate**, **Show as…** (switch its type) or **Delete view**. Deleting a view never deletes rows.

| View | Good for |
|---|---|
| **Table** | The classic grid. Click a cell to edit; open icon on each row opens it as a page |
| **Sheet** | Spreadsheet feel. Arrow keys move, Shift extends a selection, Enter, F2 or just typing edits a cell, Delete clears it, **Ctrl/Cmd + C / V** copy and paste (including to and from Excel or Google Sheets). A footer row can total each column (Count, Sum, Average, Min, Max…) |
| **Board** | Cards in columns by a field (a select or checkbox by default). Drag cards between columns to change the value |
| **List** | A compact list, one row per line |
| **Gallery** | Cards in a grid |
| **Calendar** | Rows on a month grid, based on a date column. Choose which date column with the **Date** button; use the arrows to change month. Rows with no date wait underneath |
| **Feed** | A stream of posts: each row's title, date and the start of its text |
| **Chart** | Bar, line or pie. Pick the **X axis (group by)**, and the value: row count, or Sum, Average, Min or Max of a number column |
| **Dashboard** | A ready-made overview: counts and totals for your number and checkbox columns, plus charts |

Boards, lists, galleries, the calendar and feeds all have an add button so you can create a row right there.

**Row height.** In a table or sheet view, **Row height** (toolbar or view menu) sets Compact, Normal or Tall, or a custom size, for that view only.

### Filter, sort, group

The toolbar above the data has:

- **Filter:** add one or more rules, such as "Status is Done" or "Amount greater than 100". Choose whether **all** or **any** rules must match. The available conditions depend on the column type (contains, is, before, after, is empty, checked, and so on). **Clear filters** removes them.
- **Sort:** sort by one or more columns, each ascending or descending. Empty values always come last. **Clear sorting** removes them.
- **Group:** group rows by any column (not offered for Calendar, Sheet, Chart and Dashboard).
- **Properties:** choose which columns this view shows. The first column (the title) always stays.
- **Layout** (Table and Sheet): **Wrap all cells** or wrap particular columns, **Freeze columns** (the first 1, 2 or 3 stay in place when you scroll sideways), **Column width** (Narrow, Medium, Wide, Extra wide) and **Reset widths**.

Filters, sorts and layout are saved per view, so a "Done" view and a "To do" view of the same data can sit side by side.

### Linked views

Want the same data in two places? **New → Database view of…** or **Sheet view of…** and pick the source database. You get a new item in the sidebar, with its own filters, sorts and layout, that **always shows the same rows** as the original. Edit a row in either place and both update. Adding a row works from either one. If the source database goes to the trash, the linked view says so; restore the source to bring it back.

### Database views in a page, and data sources

**Show a database inside a page.** Type `/view` (Database view) and pick a source: databases marked as data sources come first, then your other databases, then tables marked as data sources. Then choose a tab: one of the source's own views (always showing its current filters and layout), or **Custom**, a view that belongs only to this block (its own layout, filters, sorts, groups and column display). Rows you edit or add in the block are the source's rows. The block's ⋯ menu (or right-click / long-press its header) can change the source, open it, copy a source view into a custom one, or turn a custom view into a view of the source. If the source is in the trash, the block says so. Tall tables scroll inside the block.

**Data sources.** Right-click a database in the sidebar (or use its ⋯ page menu) and choose **Data source**. It stays in the tree with a small badge and is listed first in every source list: view blocks, **New → Database view of…**, value chips and record previews. It's still an ordinary, editable database.

**Tables as data sources.** In a `/table` block's handle menu choose **Use as data source**, give it a name and pick a key column. The first row becomes the column names. The table then appears as "Table: <name> on <page>" and can be shown in a view block, used in value chips and previewed, read-only (edit the table block itself). **Convert to database** turns it into a real database next to the page and replaces the table with a view of it.

### Import and export CSV

- **Create a new database from a CSV file:** **New → Database from CSV…** and choose a `.csv`, `.tsv` or `.txt` file. The first line becomes the column names. Denotation guesses each column's type (number, checkbox for true/false/yes/no, date for `YYYY-MM-DD`, otherwise text) and works out the separator (comma, semicolon, tab or `|`). Up to 5,000 rows.
- **Add rows to an existing database:** the **CSV** button in the toolbar, then **Import rows from CSV…**. Columns are matched by name; if no names match, the columns are matched by position instead.
- **Export:** **CSV → Export this view as CSV** saves what the current view shows (so filters and sorts apply). Text cells that start with `=`, `+`, `-` or `@` get a leading `'` so a spreadsheet opens them as text, not formulas.

---

### Custom (JSON) columns

Choose the column type **Custom (JSON)** and write a type, for example `Dictionary{name: String, level: int(1..99), stats: Dictionary{hp: int, sp: int}}`. Building blocks:

- `String`, `bool`, `int`, `float`; ranges `int(0..10)`, `float(..1.5)`
- one of several words `("low", "mid", "high")`; any of several `Array[("a", "b")]`
- lists `Array[T]`; fixed fields `Dictionary{key: T, …}` (nest freely); any object `Dictionary`
- alternatives `String | Dictionary{…}`

Click a cell to edit it in a form (number fields with sliders, pickers for choices, add/remove/reorder for lists, a shape switch for alternatives) or in the **Raw JSON** tab. Numbers outside their range are clamped when you leave the field. Values that don't match the type are kept as written and marked with a warning icon and the reason. The row page shows the full form. Filters and sorts can read a field: type a path such as `stats.hp` next to the property. CSV export writes the JSON text.

**Edit columns as JSON** (column header menu, or **Properties → Edit columns as JSON…**) edits the whole column setup as `{ columns, columnGroups }`. It's checked before saving, with a message for each problem. Keep each column's `id` so its values survive; removing a column asks first.

### Column groups

In a column header's menu choose **Group with…**, pick the columns and name the group. Grouped columns sit next to each other under a label row in tables and sheets. Click or right-click a label to rename it, add or remove columns, collapse or expand it (each view remembers its own), add a subgroup (two levels at most) or ungroup. Row pages and record previews list properties under their group headings.

### Column display

Each column can show values as **Clip** (default), **Wrap**, **Marquee** (long text scrolls sideways; it stays still with reduced motion), **Obfuscate** (`———` until you open the cell) or **Hide contents** (a narrow blank column). Set it in the column editor for all views, or per view in the column header menu (**Display in this view**), **Properties**, or **Layout → Column display**. Search, filters, sorts, formulas and exports always use the real value. Obfuscate is for tidiness and screen privacy, not security. **Column width…** in the column menu sets a width from the keyboard or on touch.

On a phone, tap a calendar day to see its rows and add one.

### Right-click menus in databases

- Right-click a row, card or post in any layout (long-press on a phone, or Shift+F10 / the Menu key on a focused item) to open, duplicate, copy a link to, or delete it. Delete asks first and can't be undone.
- Right-click a column header in a table or sheet to edit the column, sort by it, hide it in this view, or add a column.
- Right-click a view tab to rename, duplicate, change layout or delete the view (the active table or sheet view also has **Layout settings**).
- Your browser's normal menu still appears on text fields, links and selected text, so copy and paste keep working. In locked linked views, Duplicate and Delete are greyed out.

## 5. Formulas

Add a column, set its type to **formula**, and type an expression. It is calculated for every row, shows live, and you cannot type over the result. The editor checks it as you type and shows an error message if something is wrong, and it lists your other columns as buttons: click one to insert it.

### The basics

- Refer to another column of the same row by its name in square brackets: `[Price] * [Qty]`.
- Join text with `&`: `[First] & " " & [Last]`.
- Text goes in double quotes. Dates are text in the form `"2025-12-31"`.
- Operators: `+ - * / ^`, comparisons `= <> < > <= >=`, and `&`.
- For every row at once, use `ALL([Column])` inside a function: `[Amount] / SUM(ALL([Amount]))` gives each row's share of the total.
- If a calculation can't work, the cell shows a code such as `#DIV/0!`, `#VALUE!`, `#NAME?`, `#NUM!` or `#N/A` rather than breaking anything.

Examples:

```
[Price] * [Qty]
IF([Status] = "Done", 1, 0)
[Amount] / SUM(ALL([Amount]))
ROUND([Score] * 100, 1) & "%"
DATEDIF([Start], TODAY(), "D")
```

### Functions

| Group | Functions |
|---|---|
| **Logic** | `IF`, `IFS`, `IFERROR`, `IFNA`, `SWITCH`, `AND`, `OR`, `NOT`, `XOR` |
| **Checks** | `ISBLANK`, `ISNUMBER`, `ISTEXT`, `ISERROR` |
| **Totals and counts** | `SUM`, `AVERAGE`, `MIN`, `MAX`, `COUNT`, `COUNTA`, `COUNTBLANK`, `PRODUCT`, `MEDIAN`, `LARGE`, `SMALL`, `UNIQUE_COUNT` |
| **Conditional totals** | `SUMIF`, `COUNTIF`, `AVERAGEIF` |
| **Maths** | `ABS`, `ROUND`, `ROUNDUP`, `ROUNDDOWN`, `INT`, `TRUNC`, `CEILING`, `FLOOR`, `MOD`, `POWER`, `SQRT`, `EXP`, `LN`, `LOG`, `LOG10`, `SIGN`, `PI`, `FACT` |
| **Text** | `CONCAT`, `CONCATENATE`, `TEXTJOIN`, `LEFT`, `RIGHT`, `MID`, `LEN`, `UPPER`, `LOWER`, `PROPER`, `TRIM`, `SUBSTITUTE`, `REPLACE`, `FIND`, `SEARCH`, `REPT`, `EXACT`, `VALUE`, `TEXT` |
| **Dates** | `TODAY`, `NOW`, `DATE`, `YEAR`, `MONTH`, `DAY`, `WEEKDAY`, `DAYS`, `EDATE`, `EOMONTH`, `DATEDIF` |
| **Lists and rows** | `INDEX`, `ALL`, `ROW`, `ROWS`, `PROP` |

`TEXT` formats a value, for example `TEXT([Rate], "0.0%")`, `TEXT([Total], "#,##0.00")` or `TEXT([Date], "dd/mm/yyyy")`. `DATEDIF` takes `"D"` (days), `"M"` (months) or `"Y"` (years).

Pivot tables and the sheet footer are the quickest way to total a column without writing a formula.

---

## 6. Feedback

**Feedback** is a built-in way to jot down an idea, a problem or a feature request, for yourself or for whoever looks after your workspace. It isn't an outside service: feedback stays in your own workspace.

1. Open **⋯ → Feedback**.
2. Choose **Feedback** or **Feature request**.
3. Write a short **title**, then press **Enter** to start writing.
4. Write it just like a page: type `/` for blocks, use markdown shortcuts, and paste or drop pictures.
5. Press **File feedback** (or **Cancel**, which leaves no trace).

The first one creates a database called **Feedback** in your repository, with the columns *Title*, *Type*, *Status* (Open, In progress or Done) and *Details*, and two views: **All feedback** (a table) and **By status** (a board). Each item is a row and a full page. Move items across the board as they progress. A database from an older version called **Tickets** is renamed to Feedback automatically.

---

## 7. Your data

### Where it lives

Denotation has no server. In a normal browser, everything is stored in that browser's **localStorage**, for the exact address you opened. The sidebar footer says **Storage: this browser**.

- It stays after you close the tab or restart your computer.
- It is **not** shared between browsers, devices, profiles, or between `localhost` and `127.0.0.1`.
- If you clear the browser's site data, your workspace goes with it.
- Inside a Claude artifact, the footer instead says the data is stored in Claude.
- If the browser blocks storage (some private windows do), Denotation says so and changes last **only until you close the page**.

Changes are saved automatically a moment after you stop typing. When you move to another page the pending change is saved first.

### Storage limits

Browsers usually allow around **5 MB** of localStorage per site. Text takes very little room. Images take a lot, because they are stored inside your pages (Denotation shrinks them first, but a few dozen photos can still fill it). If saving fails you will see an error message. Free up space by deleting big images or old pages, emptying the trash, and exporting a backup first.

### Export and import (backups)

Open the **⋯** menu at the top of the sidebar and choose **Export** or **Import**.

**Export** offers:
- **JSON file:** one file with everything, named like `denotion-2025-01-31.json`.
- **ZIP — Denotation JSON:** everything, one file per page and row. Use this for backups, because it restores exactly.
- **ZIP — Markdown:** plain `.md` files and `.csv` tables that any editor (Obsidian, VS Code, Notion's importer…) can read. Views, column types and colours aren't kept. Page properties go in front matter at the top of each file, and Markdown import reads simple ones back. Archived pages are left out, like the trash.
- **To folder — Markdown / Denotation JSON** (Chrome or Edge on a computer): the same, written straight into a folder you pick. Files with the same names are overwritten.

The Markdown layout looks like this:

```
My repository/
  Welcome.md            a page (title in a small header at the top)
  Welcome/              its sub-pages, next to it with the same name
    A sub-page.md
  Tasks.csv             a database: one row per line
  Tasks/                row pages that have content
    Buy milk.md
attachments/            pictures from your pages
```

Names are tidied so they work on every computer, and links between pages become ordinary relative links.

**Import** offers:
- **File…:** pick one or more `.zip`, `.json`, `.md` or `.csv` files.
- **From folder…** (Chrome or Edge on a computer): read a whole folder, for example an Obsidian vault.

What happens depends on the format:
- **Denotation JSON** (a ZIP or JSON export) **restores**: pages and rows with the same identity are overwritten, new ones are added, nothing is deleted.
- **Markdown** never overwrites anything. A ZIP or folder becomes a **new repository** named after it, so importing twice gives two copies. Folders become sub-pages, `.csv` files become databases, front-matter `title:` or the first `# Heading` becomes the page title, pictures next to the notes are embedded (up to 200 KB each), and `[[wiki links]]` become page links. Hidden folders like `.obsidian` are skipped.

Exporting and re-importing is also how you move your workspace to another browser or computer.

Smaller exports are available too: a page's **Export as Markdown** (page options menu), and a database view's **CSV → Export this view as CSV**.

> **Make a backup now and then.** Browser storage is convenient but not permanent. Exporting once a week, or before clearing your browser, takes ten seconds.

### Storage: main and backups

In Chrome or Edge on a computer, **⋯ → Storage…** lets you choose where your workspace is kept besides this browser.

**Add a location.** **Add location… → Folder as main…** or **Folder as backup…**, then pick a folder. (Google Drive and OneDrive are listed as *coming soon*. Until then, pick a folder inside the Google Drive, OneDrive or Dropbox folder on your computer and it syncs through them.) Denotation only writes its own files there: `denotation.json`, `pages/`, `rows/`, `tombstones/` and `permissions.json`.

**Main** (at most one): your workspace syncs with it both ways.
- **Auto** (default): Denotation pulls the main's changes when you connect, and whenever the folder has a newer version (checked when you come back to the window and every 30 seconds). Your edits are pushed every 5 minutes (choose 5, 10, 15, 30 or 60 under **Auto push every** in Storage), and right away when you close or leave the tab. The footer shows how many changes are waiting and when the next push is. When both sides changed the same page, the newest version wins.
- **Manual:** nothing happens on its own. Use **Pull** (main → this browser) and **Push** (this browser → main) from the ⋯ menu, the Storage dialog or the footer. Pulls and pushes (including automatic pulls) share a **30-second cooldown**: after one runs, the buttons wait and show the seconds left. The footer tells you about *changes not pushed* and when *the folder has newer changes*.
- **Warnings:** **Push** warns you when the folder has newer copies than yours ("The folder has newer changes"), and **Pull** warns you when the folder's copies are older than yours ("This browser has newer changes"). The warning lists the pages with both dates. Choose **Cancel**, **Merge (keep newest)**, or **Push anyway** / **Pull anyway** to overwrite.
- Deleting a page on one computer also deletes it on the others (unless someone edits it again afterwards).

**Backups** (any number) are **copy-only**: Denotation copies your workspace into them after each sync, but never reads them on its own. Each backup has:
- **Restore from this backup…**, which brings the backup's pages and rows back (after a warning). Pages created since the backup are kept.
- **Make main**, which turns it into the main; the old main becomes a backup.

**Remove** stops using a location; its files stay where they are. After a restart, your browser may need your permission again: the footer says so, and your first click anywhere asks for all locations at once (Chrome can offer **Allow on every visit**).

Other browsers (Firefox, Safari, phones) can't use folders. Use Google Drive, OneDrive or the ZIP export instead.

**Adding Google Drive or OneDrive.** Open **⋯ → Storage… → Add location…**, then choose Google Drive or OneDrive as main or as backup. Enter a workspace folder name (default "Denotation"; use the same name on every device). For Google Drive, pick **Folder in My Drive** (visible in Drive) or **Hidden app folder**. Press **Sign in…** and allow access in the window that opens. Denotation can only see the files it creates. If pop-ups are blocked, you can sign in in the same tab; the page reloads and adds the location.

Google sign-ins last about an hour and OneDrive sign-ins about a day. When one runs out, the location shows **Signed out**: press **Sign in…** to resume; your edits stay in this browser meanwhile. Encryption, Pull / Push, auto sync and restoring from a backup work as they do for folders. Items over 4 MB stay in this browser only (a warning says so). If the menu says **Not configured**, the site owner hasn't added a client ID yet.

### Let an AI assistant use your workspace

Assistants such as Claude Code can read and change your workspace through a small local connector (an MCP server that comes with Denotation). You decide exactly what they may do.

**1. Set permissions.** Open **⋯ → AI access…**. For each action (**Read**, **Create**, **Edit**, **Delete**) choose:
- ✗ **No:** not allowed.
- ✓ **Yes:** allowed.
- – **Ignore:** not set here, so the level above decides.

That's the **workspace** setting. To set one repository, page or database differently, right-click it in the sidebar (or long-press, or Shift+F10) and choose **AI access…**. The closest setting wins: a page's own choice, then its parent's, and so on up to its repository, then the workspace. Rows follow their database. If nothing says Yes, the answer is **No**, so by default assistants can do nothing. The page dialog shows the effective result and where it comes from.

**2. Connect.** The connector works on a [connected folder](#storage-main-and-backups), so connect one first (Chrome or Edge). Then add the connector to your assistant. For Claude Code:

```bash
claude mcp add denotation -- node <path to Denotation>/source/mcp/denotation-mcp.mjs --folder <path to your folder>
```

It needs [Node.js](https://nodejs.org) on your computer. Other assistants and options are in [source/mcp/README.md](source/mcp/README.md).

**3. Use it.** Ask the assistant to list, read, search, create, edit or delete pages and rows. Anything not allowed is refused, and pages it can't read stay invisible, titles included. Archived pages are hidden from its page list and search unless it asks to include them. Its changes show up in Denotation when you switch back to the window, or within 30 seconds: the assistant marks the folder as changed and Denotation then pulls (in manual mode use **Pull**).

> **Keep the folder private to the connector.** Permissions are checked by the connector. An assistant that can also open files directly (for example one started inside that folder) could get around them.

---

## Security and PIN lock

Open **⋯ → Settings → Security** to set a 4- or 6-digit PIN for this browser.

- With a PIN, Denotation opens on a lock screen, and locks itself after the idle time you choose (Never, 1, 5, 15 minutes or 1 hour; default 5). **⋯ → Lock now** locks at once.
- On its own, the PIN hides the app on this device; it doesn't encrypt anything. For that, turn on encryption (below).
- After a wrong PIN, input is blocked for 3 seconds, then you can try again.
- **There is no PIN reset.** If you forget it, choose **Forgot PIN? Reset this browser** on the lock screen.
- **Reset local cache** (Settings → Security) deletes all Denotation data in this browser: pages and rows, preferences, the PIN, the AI access copy and storage-location links. Folders on disk are not touched. To confirm, type the 8-digit number shown (a new one each time). Export first if you have no main storage location or have unpushed changes.
- Locking applies to the tab you're in; other open tabs don't lock.

### Encryption

**Settings → Security → Encryption** (needs a PIN):

- **Encrypt storage locations…** encrypts every page and row file in your main location and backups with a key unlocked by your PIN. Folder and file names stay visible. Every location must be connected; you can export a backup first. Progress is shown, and an interrupted job continues on the next unlock.
- When you turn it on, a **recovery key** (8 groups of 4 characters) is shown once. Save it: it's the only way back if you forget your PIN. Turn on **Keep recovery key in the app** to view it later under **Show recovery key** whenever the app is unlocked (changing this later makes a new recovery key).
- **Also encrypt the browser copy** encrypts the pages kept in this browser too (off by default).
- **Another device:** when you connect an encrypted folder, enter that folder's PIN or its recovery key; if it differs from this device's PIN, you're asked for this device's PIN too. Until then the folder shows **Encrypted — unlock to sync** and nothing is written to it.
- **Changing the PIN** re-protects the key everywhere. **Removing the PIN** needs encryption turned off first. Turning encryption off decrypts every file safely, resuming if interrupted.
- A 4–6 digit PIN can be guessed by someone who has a copy of the files, so keep the files private. If you forget the PIN and lose the recovery key, encrypted data can't be recovered. The AI access (MCP) server can't read encrypted folders.

**Password-protected exports:** **Export → ZIP with options… → Protect with a password** makes a standard AES-256 ZIP (made for 7-Zip, WinRAR, Keka and macOS Archive Utility, though not yet tried in those apps; Windows Explorer may not open it). JSON exports are always plain. Importing a protected ZIP asks for the password.

## 8. Appearance

Click **Settings** in the sidebar to open **Appearance**. Changes apply immediately and are remembered in your browser.

- **Theme:** Denotation has one clean theme in four shades:
  - **Neutral** (the default): a soft, low-glare grey.
  - **Light:** white pages.
  - **Dark:** dark pages for night use.
  - **Variable:** Light from 07:00 to 19:00 your local time, Dark the rest of the day. It switches by itself.
- **Font:**
  - **Recommended:** System sans (the default), System serif, System monospace, Noto Sans, Noto Serif and Noto Sans Mono. The Noto fonts come with the app, so they work offline and look the same everywhere.
  - **On this device:** in Chrome or Edge, **Show fonts installed on this device** lists the fonts on your computer (your browser asks for permission first). In other browsers, type a font name instead. These fonts only work on the device that has them, so they aren't recommended.
- **Font size:** a slider from 12 to 24 px.
- **Heading sizes:** two numbers.
  - **Font size steps** is the size added for each heading level. `0` keeps the default heading sizes.
  - **Font size intercept** is added to every heading.
  - A preview line shows the resulting H4 to H1 sizes.
- **Accent colour:** pick one of 24 hues or grey. Grey shows as dark grey in Neutral and Light, and light grey in Dark. By default the accent is **Random**: a different hue each time you open the app, never grey. Choose Random again to go back to it.
- **Sidebar:** **Keep the sidebar locked open** (see [section 2](#2-finding-your-way-around)).
- **Reset all** puts every appearance setting back to the defaults (except the sidebar lock).

---

## 9. Keyboard shortcuts

On Mac, use **Cmd** where this guide says **Ctrl**.

**Anywhere**

| Keys | What it does |
|---|---|
| Ctrl/Cmd + K | Quick find |
| Ctrl/Cmd + \\ | Open or close the sidebar (when it is unlocked) |
| Shift+F10 | Open the menu of the focused sidebar item (browser context-menu key) |
| Enter | Open the focused sidebar item |

**While writing**

| Keys | What it does |
|---|---|
| `/` | Insert menu |
| `@` | Mention a page |
| Enter | New block below |
| Tab / Shift+Tab | Nest the block under the one above / bring it back out |
| Ctrl/Cmd + B | Bold the selection |
| Ctrl/Cmd + I | Italic |
| Ctrl/Cmd + E | Inline code |
| Ctrl/Cmd + K | Turn the selection into a link (type the address where `url` is) |
| Ctrl/Cmd + D | Duplicate the block |
| Ctrl/Cmd + Shift + Up / Down | Move the block up or down |
| Ctrl/Cmd + Enter | Tick a to-do, fold/unfold a toggle, or leave a code block |
| Backspace at the start of a block | Merge with the previous block |
| Up / Down at the edge of a block | Move into the neighbouring block |

Quick find takes over Ctrl/Cmd + K everywhere except inside a block's text box, where it makes a link instead. Click outside the text first if you want quick find.

**In a Sheet view**

| Keys | What it does |
|---|---|
| Arrow keys | Move between cells |
| Shift + Arrow keys | Extend the selection |
| Tab / Shift+Tab | Next / previous cell |
| Enter, F2, or just start typing | Edit the cell |
| Delete / Backspace | Clear the selected cells |
| Space | Toggle a checkbox cell |
| Ctrl/Cmd + A | Select everything |
| Ctrl/Cmd + C / V | Copy and paste, including with Excel and Google Sheets |
| Esc | Collapse the selection |

---

## 10. Troubleshooting

**The page is blank, or a message about modules appears.**
You probably opened `index.html` as a file. Use `npm start` and go to http://localhost:8080 ([section 1](#1-running-denotation)).

**`npm start` fails, or says the port is busy.**
Make sure Python 3 is installed (`python3 --version`). If port 8080 is in use, stop the other program using it. Remember that a different port is a different address, so your workspace will look empty there ([section 1](#1-running-denotation)).

**My pages are gone / the workspace looks empty.**
- Check the address bar. `localhost` and `127.0.0.1`, and different ports, each hold separate workspaces.
- Check you are in the same browser and profile as before.
- If you cleared your browser's site data, the workspace was cleared with it. Restore from an export with **Import**.
- Check the sidebar footer. If it says changes last only until you close the page, your browser is blocking storage.

**A message says it could not save, or things stop saving.**
Browser storage is probably full (around 5 MB). Export a backup, then delete large images, old pages and trashed items.

**An image won't show.**
Pictures linked from other websites are sometimes blocked, especially inside Claude artifacts. Use **Upload image** to embed the file itself.

**I can't type in a page.**
The page may be locked. Open **Page options → Lock page** to switch it off. Pages in the trash are read-only; restore them first.

**A page vanished from the sidebar.**
Look in **Trash** and press **Restore**. Pages inside a trashed page are hidden with it.

**A formula shows an error code.**
`#DIV/0!` is a division by zero, `#VALUE!` means a value of the wrong kind (such as text in a sum), `#NAME?` is a misspelled function, `#NUM!` is an impossible number. Check the column names in `[brackets]` match exactly, and that text is in double quotes.

**A CSV import said there is no data, or too many rows.**
The file needs at least one line, and the limit is 5,000 rows. For rows added to an existing database, at least one column name must match, otherwise columns are matched by position.

**Import failed: "Not a Denotion export file".**
Import only reads the `.json` files made by the sidebar's **Export**. A CSV or Markdown export is imported through a database instead.

**Export gave me nothing to download.**
Some embedded views block downloads. Denotation then copies the data to your clipboard. Paste it into a text file and save it as `.json`.

**Ctrl/Cmd + K typed a link instead of opening quick find.**
Inside a block, that key makes a link. Click outside the text first, or use the **Search** button in the sidebar.

**Something else is wrong.**
Reload the page, since your changes are saved as you go. If it keeps happening, file **Feedback** (section 6) describing what you did, then export a backup.

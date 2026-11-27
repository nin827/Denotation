# Denotation — User Guide

This guide covers everything from opening Denotation for the first time to building your own databases. For a short introduction, see the [README](README.md).

Denotation is a personal workspace that runs entirely in your browser: pages made of blocks, databases with many kinds of views, formulas, and a few tools to keep it all tidy. There is no account and no server.

> **A note on the name:** the app itself still shows "Denotion" in its sidebar and in the files it exports. It is the same app.

**Contents**

1. [Running Denotation](#1-running-denotation)
2. [Finding your way around](#2-finding-your-way-around)
3. [Writing pages](#3-writing-pages)
4. [Databases](#4-databases)
5. [Formulas](#5-formulas)
6. [Tickets](#6-tickets)
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

> **Open it over `http://`, not as a file.** Double-clicking `public/index.html` will not work, because browsers refuse to run the app's code straight from a folder. Always use the address above.

> **Keep the same address.** Your workspace belongs to one exact address, port included. If you open `http://localhost:8080` one day and `http://127.0.0.1:8080` the next, each one looks like a brand new, empty workspace. Pick one and stick with it.

### B. Install it as an app

*Coming soon.* Denotation will be hosted on GitHub Pages so you can install it like an app on your phone or computer. This is not available yet.

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
| Lock / close icons | Lock the sidebar open, or close it when it is unlocked |
| **Search**, **Settings**, **Ticket**, **Trash** | The four tools. Settings opens [Appearance](#8-appearance); Ticket opens the [feedback form](#6-tickets) |
| **Favorites** | Pages you starred (only shown when you have some) |
| **Repositories** | Your top-level folders, with their pages nested underneath |
| Footer | Where your data is stored, plus **Export** and **Import** |

On a wide screen the sidebar is **locked open** by default. Unlock it with the padlock icon if you want more room: it then slides in over the page when you open it, and out of the way when you pick a page. On a phone it starts closed, and a small button on the left edge opens it. **Ctrl/Cmd + \\** also opens and closes the sidebar once it is unlocked.

### Repositories, pages and databases

- A **repository** is a top-level container, like a notebook or a project folder. A new workspace starts with one called "My repository", holding a welcome page and a small example database.
- A **page** holds blocks of content. Pages can contain **sub-pages**, as deep as you like. Click the small arrow beside a name to fold or unfold what is inside.
- A **database** holds rows of structured data. See [section 4](#4-databases).
- Click a repository's name to see its contents as cards, with **New page**, **New database** and a **More** menu.

Create something new with the **New** button in the sidebar. It adds to the repository you are currently in. The menu offers:

- **Page**
- **Database** and **Sheet** (listed under *Original source*)
- **Database from CSV…**
- **Database view of…** and **Sheet view of…** (listed under *View of an existing source*, see [linked views](#linked-views))

Use the **+** beside **Repositories** to create a new repository.

### The page menu (right-click, long-press or Shift+F10)

Every item in the sidebar has its own menu:

- **Desktop:** right-click it.
- **Phone or tablet:** press and hold it for about half a second.
- **Keyboard:** Tab to the item and press **Shift+F10** (or the Menu key). This uses your browser's standard context-menu key, so it can depend on your system.

The menu has **Open**, **Add sub-page** (or **Add page or database** on a repository), **Rename**, **Add to favorites** / **Remove from favorites**, **Duplicate** and **Move to trash**.

When you are on a page, the **⋯ Page options** button at the top has more: change icon, **Full width**, **Small text**, **Lock page**, **Duplicate**, **Move to** another page or repository, **Export as Markdown** and **Move to trash**. Beside it is a star to add the page to your favorites. You can also add an icon and a cover (a choice of eight gradients) from the top of the page.

The breadcrumb at the top shows where you are; click any part to go back up.

### Quick find

Press **Ctrl/Cmd + K** (or click **Search**) and start typing. It searches page titles, page text and database rows. Press **Enter** to open the first result, or click any result.

### Favourites

Star a page with the star at the top of the page, or choose **Add to favorites** from its menu. It then appears under **Favorites** at the top of the sidebar. Repositories cannot be favourited.

### Trash

**Move to trash** hides a page everywhere else, but nothing is gone yet. Open **Trash** in the sidebar to:

- **Restore** a page, or
- **Delete forever** (it asks first), or
- **Empty trash** to clear everything.

Trashing a page also hides the pages inside it. Deleting a database row from its page asks for confirmation and removes it permanently, with no trash step.

---

## 3. Writing pages

### Blocks

A page is a stack of **blocks**: paragraphs, headings, lists and so on. Click anywhere in a block to write in it. Each block has a **handle** (three lines) on its left that appears when you hover. Hovering is not needed on touch screens.

- **Click the handle** for the block menu.
- **Drag the handle** to move the block, even into a column or another position in a list.

The block menu has:

- **Turn into**: change the type of the block.
- **Color**: set a text colour or a background colour (gray, brown, orange, yellow, green, blue, purple, pink, red).
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

**Callout.** A highlighted note with an icon on its left. Click the icon to choose another. Use the handle menu to colour it. (There is no markdown shortcut; use `/callout`.)

**Quote.** A quoted passage. Colours work here too.

**Code.** Monospaced text, with a language picker (plain, js, ts, python, json, html, css, bash, sql, java, c, go, rust, markdown) and a **Copy** button. Enter adds a new line inside it; **Ctrl/Cmd + Enter** leaves the block and starts a new paragraph below. Tab inserts two spaces.

**Table.** A grid you type straight into. Controls under the table set the number of **Rows** (up to 100) and **Columns** (up to 12), and whether the first row and first column are headers. This is a simple text table; for data you want to sort, filter or calculate, use a [database](#4-databases).

**Columns.** Two to six side-by-side columns. Each is a mini-page of its own: drag blocks into and between them with the handle. Change the count from the block's handle menu.

**Image.** Choose **Upload image** (pictures are shrunk to fit), or paste a link with **Embed link**. Add a caption underneath. You can also paste an image straight in. If an image from another website won't load, upload the file instead.

**Web bookmark.** A card showing a link: enter an address and an optional title, then **Save**. Clicking the card opens the link in a new tab.

**Table of contents.** A list of all the headings on the page. Click one to jump to it. It updates itself as you add headings.

**Breadcrumb.** Shows the path to this page, as a clickable trail.

**Page.** Creates a sub-page right where you are and drops a link to it. Existing pages can be linked with `@`. Links to a trashed or deleted page say so instead of vanishing.

**Database.** The same, but a new sub-database.

**Synced block.** Turn any block into a synced block from its handle menu. Edits made to it show up everywhere the same synced block is used, which makes it good for something you repeat on many pages, such as a footer or a contact box. Use **Unsync (make independent copy)** to break the connection. A synced block cannot contain itself.

**Pivot table.** A summary of a database inside your page. See below.

### Pivot tables

Insert one with `/pivot`. Then, using the controls on the block:

1. **Database:** choose which database to summarise.
2. **Rows:** choose a field to group by. (Select, checkbox, text, date, number, array and dictionary fields work.)
3. **Columns:** optional second field to split by.
4. **Value:** *Count of rows*, or pick a number column.
5. **Calculate:** when a number column is chosen, pick Sum, Average, Min or Max.

Totals for every row and column are shown, and the table updates when the database changes.

### Locking a page

**Lock page** in the page options makes the whole page read-only: no handles, no typing. Unlock it the same way. Pages in the trash are read-only too.

---

## 4. Databases

A database is a table of **rows**, where every row has the same **columns**. **Every row is also a full page:** click the open icon on a row to write notes, add blocks and more inside it.

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

### Import and export CSV

- **Create a new database from a CSV file:** **New → Database from CSV…** and choose a `.csv`, `.tsv` or `.txt` file. The first line becomes the column names. Denotation guesses each column's type (number, checkbox for true/false/yes/no, date for `YYYY-MM-DD`, otherwise text) and works out the separator (comma, semicolon, tab or `|`). Up to 5,000 rows.
- **Add rows to an existing database:** the **CSV** button in the toolbar, then **Import rows from CSV…**. Columns are matched by name; if no names match, the columns are matched by position instead.
- **Export:** **CSV → Export this view as CSV** saves what the current view shows (so filters and sorts apply).

---

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

## 6. Tickets

The **Ticket** button in the sidebar is a built-in way to jot down feedback or a request, for yourself or for whoever looks after your workspace. It is not an outside service: tickets live in your own workspace.

1. Click **Ticket** in the sidebar.
2. Choose **Feedback** or **Request**.
3. Write a short **Title**.
4. Add **Details** if you like. Markdown works (`**bold**`, `` `code` ``, lists, quotes, links), there is a small toolbar, and a **Preview** tab. You can attach up to three small pictures: paste or drop them in, or use the picture button.
5. Press **File ticket**.

The first ticket creates a database called **Tickets** in your repository. It has the columns *Title*, *Type*, *Status* (Open, In progress or Done) and *Details*, plus two views: **All tickets** (a table) and **By status** (a board). Each ticket is a row, and a full page, so the long write-up and pictures are inside it. Move tickets across the board as they progress.

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

In the sidebar footer:

- **Export** downloads a file named like `denotion-2025-01-31.json` with all your pages and database rows. In places where downloads are blocked, it copies the data to your clipboard instead; paste it into a text file and keep it.
- **Import** reads such a file back in. Pages and rows with the same identity are **overwritten** by the ones in the file; anything in the file that is new is added; anything *not* in the file is left alone. It tells you how many pages and rows it brought in.

This is also how you move your workspace to another browser or computer: **Export** in the old one, **Import** in the new one.

Smaller exports are available too: a page's **Export as Markdown** (page options menu), and a database view's **CSV → Export this view as CSV**.

> **Make a backup now and then.** Browser storage is convenient but not permanent. Exporting once a week, or before clearing your browser, takes ten seconds.

---

## 8. Appearance

Click **Settings** in the sidebar to open **Appearance**. Changes apply immediately and are remembered in your browser.

- **Font family:** System sans, System serif, System monospace, or Inter, Nunito, IBM Plex Sans, Lora, Merriweather, Source Serif 4, Playfair Display, JetBrains Mono. Choose **Custom font name…** to type any Google Fonts family (or a font installed on your device). The named web fonts are loaded from Google Fonts, so they need an internet connection the first time.
- **Font size:** a slider from 12 to 24 px.
- **Heading sizes:** two numbers.
  - **Font size steps** is the size added for each heading level. `0` keeps the default heading sizes.
  - **Font size intercept** is added to every heading.
  - A preview line shows the resulting H4 to H1 sizes.
- **Colors:** a row of theme presets (Theme default, Sepia, Rose, Slate, Midnight, Forest, High contrast), plus **Background** and **Font color** pickers for any colour you like. Each has a reset button.
- **Accent colour:** Pick one of 24 accent hues or grey in Settings → Appearance. Grey shows as dark grey in light mode and light grey in dark mode. By default the accent is Random: a different hue each time you open the app, never grey. Choose Random again to go back to it.
- **Sidebar:** **Keep the sidebar locked open** (see [section 2](#2-finding-your-way-around)).
- **Reset all** puts every appearance setting back to the defaults (except the sidebar lock).

**Light and dark:** Denotation follows your device's light or dark setting automatically. To force a darker or lighter look regardless, pick a theme preset or set your own **Background** colour (the text and accent adjust to suit it).

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
Reload the page, since your changes are saved as you go. If it keeps happening, file a **Ticket** (section 6) describing what you did, then export a backup.

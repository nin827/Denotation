// Callout presets: the looks a callout can follow. Data only, so adding or changing a preset touches just this file.
//   id     stable key stored on the block (`block.preset`) and in automatic-callout rules; never rename one in use
//   label  name shown in the picker
//   icon   "icon:<lucide name>" or an emoji
//   color  text hue from the 12-hue block set (0, 30, ... 330) or null for the default text colour
//   bg     background hue from the same set, "grey", or null for no background
export const CALLOUT_PRESETS = [
  { id: "info", label: "Info", icon: "icon:info", color: 240, bg: 240 },
  { id: "tip", label: "Tip", icon: "icon:lightbulb", color: 180, bg: 180 },
  { id: "note", label: "Note", icon: "icon:sticky-note", color: null, bg: 90 },
  { id: "success", label: "Success", icon: "icon:circle-check", color: 150, bg: 150 },
  { id: "warning", label: "Warning", icon: "icon:triangle-exclamation-point", color: 60, bg: 60 },
  { id: "danger", label: "Danger", icon: "icon:octagon-x", color: 30, bg: 30 },
  { id: "question", label: "Question", icon: "icon:circle-question-mark", color: 270, bg: 270 },
  { id: "quote", label: "Quote", icon: "icon:quote", color: null, bg: "grey" }
];

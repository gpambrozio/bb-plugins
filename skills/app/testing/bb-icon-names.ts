/**
 * bb 0.44's built-in icon names — `ICON_NAMES` in the app bundle (`index-*.js`,
 * the eager set plus the extended set). The SDK types an icon name as a plain
 * string and the app draws its generic bolt for a name it does not know, so
 * `app/icons.test.ts` checks the names this plugin draws against this list.
 * Refresh it from the bundle when `bb plugin types` moves the SDK.
 */
export const BB_ICON_NAMES: readonly string[] = [
  "AlertCircle", "AlertTriangle", "Archive", "Bot", "Bug", "Check", "ChevronDown", "ChevronLeft",
  "ChevronRight", "Circle", "CircleCheck", "CircleQuestion", "CircleX", "ClosePluginPane", "CloseThreadPane",
  "Code", "ComputerTerminal01", "Copy", "Download", "Edit", "Filter", "FilterHorizontal", "Folder",
  "FolderExport", "FolderGit", "FolderPlus", "FolderSync", "FolderUnknown", "Folder02", "Info", "ListTodo",
  "Loading", "MessageQuestion", "MessageCirclePlus", "MessageSquarePlus", "MessageSquare", "MoreHorizontal",
  "PanelLeft", "Search", "SectionAdd", "SectionMove", "Settings", "SlidersHorizontal", "Spinner", "Target",
  "Terminal", "Toolbox", "ToolCase", "Trash2", "Unavailable", "UserRoundPlus", "Workflow", "X", "Zap",
  "AiBrain01", "AiBrowser", "AiContentGenerator01", "AlignLeft", "AppWindow", "ArchiveRestore", "ArrowDown",
  "ArrowLeft", "ArrowRight", "ArrowReloadHorizontal", "ArrowUp", "ArrowUpDown", "ArrowTurnBackward",
  "ArrowTurnForward", "ArrowUpRight", "Beaker", "BellDot", "Browser", "Brain", "Calendar",
  "CalendarCheckOut02", "ChartColumn", "ChevronUp", "ChevronsDown", "ChevronsUp", "CircleArrowShrink",
  "Clean", "Clock", "ClockArrowUp", "ClockArrowDown", "Cloud", "CloudOff", "Coffee", "Columns2",
  "CornerDownLeft", "CornerDownRight", "Discord", "DiscordLogo", "DateTime", "Github", "GithubLogo",
  "DragDropHorizontal", "DragDropVertical", "EditFile", "ElectricPlugs", "Eye", "EyeOff", "Explore",
  "ExternalLink", "FileDiff", "File", "FileAttachment", "FileQuestion", "FileText", "FolderOpen",
  "FolderEdit", "FolderMinus", "Fork", "GitBranch", "GitMerge", "GitPullRequest", "GitPullRequestArrow",
  "GitPullRequestClosed", "GitPullRequestDraft", "Globe", "GridView", "Laptop", "Layers", "Limitation",
  "ListEnd", "ListView", "Lock", "Mail", "MailOpen", "Maximize2", "Mic", "Minus", "Minimize2", "MoveTo",
  "NewTab", "News01", "PackageReceive", "Palette", "PanelBottom", "PanelRight", "Paperclip", "Pause", "Pin",
  "PinOff", "Play", "Plug02", "Plus", "Puzzle", "Repeat", "RotateCcw", "Rows2", "SecurityCheck", "Sent",
  "SideChat", "Smartphone", "Sort", "SortingAZ02", "SortingZA01", "SortingOneNine", "SortingNineOne",
  "Square", "SquareUnlock02", "Star", "TextWrap", "TimeSchedule", "UserRound", "ZoomIn", "ZoomOut",
];

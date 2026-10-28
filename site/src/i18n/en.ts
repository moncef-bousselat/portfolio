/**
 * English UI strings. This file is the source of truth for the key set:
 * every other locale is typed against `UIStrings`, so a missing or misspelt
 * key in a translation is a build error rather than a blank space on the page.
 *
 * These are interface strings only. Content translations (timeline entries,
 * projects, posts) are optional per item and handled by the content layer.
 */
const en = {
  'site.title': 'Moncef Bousselat',
  'site.role': 'Cloud & DevOps Engineer',

  'site.tagline':
    'I build and run cloud infrastructure for a living, and collect side projects the rest of the time.',

  'nav.label': 'Main',
  'nav.home': 'Home',
  'nav.journey': 'Journey',
  'nav.projects': 'Projects',

  'hero.cta.journey': 'See the journey',
  'hero.cta.projects': 'Browse projects',

  'journey.heading': 'Journey',
  'journey.intro':
    'Roles, degrees and certifications, most recent first. Open an entry for the detail.',
  'journey.ongoing': 'Present',
  'journey.relatedProjects': 'Related projects',
  'journey.kind.work': 'Work',
  'journey.kind.education': 'Education',
  'journey.kind.certification': 'Certification',
  'journey.kind.other': 'Other',
  'journey.credential': 'View credential',

  'projects.heading': 'Projects',
  'projects.intro':
    'Infrastructure work first. Earlier data and machine learning projects are grouped separately.',
  'projects.category.cloud': 'Cloud & Infrastructure',
  'projects.category.data-ai': 'Data & AI',
  'projects.category.development': 'Development',
  'projects.status.active': 'Active',
  'projects.status.completed': 'Completed',
  'projects.status.archived': 'Archived',
  'projects.link.repo': 'Repository',
  'projects.link.demo': 'Demo',
  'projects.link.article': 'Write-up',
  'projects.link.other': 'Link',
  'projects.readMore': 'Read more',
  'projects.openDetails': 'Open details for',
  'projects.close': 'Close',
  'projects.builtWith': 'Built with',
  'projects.empty': 'Nothing here yet.',

  'fallback.notice':
    'This entry has not been translated into French yet, so the English version is shown.',

  'nav.writing': 'Writing',
  'nav.contact': 'Contact',

  'writing.heading': 'Writing',
  'writing.intro': 'Tutorials, articles and shorter notes. Filter by type or tag.',
  'writing.type.tutorial': 'Tutorial',
  'writing.type.article': 'Article',
  'writing.type.note': 'Note',
  'writing.byType': 'By type',
  'writing.byTag': 'By tag',
  'writing.all': 'All writing',
  'writing.minRead': 'min read',
  'writing.published': 'Published',
  'writing.updated': 'Updated',
  'writing.draft': 'Draft',
  'writing.toc': 'On this page',
  'writing.empty': 'Nothing published here yet.',
  'writing.feed': 'RSS feed',
  'writing.feedDescription': 'Tutorials, articles and notes on cloud infrastructure and DevOps.',
  'writing.taggedWith': 'Tagged',
  'writing.ofType': 'Type',

  'cv.download': 'Download CV',
  'cv.downloadLang': 'CV (English)',

  'link.newTab': '(opens in a new tab)',

  'share.label': 'Share',
  'share.linkedin': 'Share on LinkedIn',
  'share.x': 'Share on X',
  'share.bluesky': 'Share on Bluesky',
  'share.reddit': 'Share on Reddit',
  'share.copy': 'Copy link',
  'share.copied': 'Link copied',
  'share.copyFailed': 'Could not copy the link',
  'share.more': 'More sharing options',

  'skip.content': 'Skip to content',

  'lang.label': 'Language',
  'lang.current': 'Current language',

  'footer.sourceCode': 'Source code',

  'notFound.title': 'Page not found',
  'notFound.body': 'Nothing lives at this address. It may have moved, or the link may be wrong.',
  'notFound.home': 'Back to the home page',

  'contact.heading': 'Contact',
  'contact.intro':
    'A question about a project, an opportunity, or something you read here? Send me a message and I will reply by email.',
  'contact.name': 'Name',
  'contact.email': 'Email',
  'contact.message': 'Message',
  'contact.messageHint': 'Up to {max} characters.',
  'contact.honeypot': 'Leave this field empty',
  'contact.submit': 'Send message',
  'contact.sending': 'Sending…',
  'contact.noscript':
    'This form needs JavaScript for its spam check, which is switched off in your browser.',
  'contact.elsewhere': 'Prefer another way? I am also on',
  'contact.success.heading': 'Message sent',
  'contact.success.body': 'Thanks for writing. I will reply to the address you gave.',
  'contact.error.name.required': 'Enter your name.',
  'contact.error.email.required': 'Enter your email address.',
  'contact.error.email.invalid': 'Enter an email address like name@example.com.',
  'contact.error.message.required': 'Write a message.',
  'contact.error.tooLong': 'This is too long.',
  'contact.error.invalidChars': 'This contains characters that cannot be sent.',
  'contact.error.fix': 'Please correct the highlighted fields.',
  'contact.error.challengePending':
    'The spam check has not finished yet. Wait a moment, then send again.',
  'contact.error.challenge': 'The spam check failed. Please try again.',
  'contact.error.challengeLoad':
    'The spam check could not load, so the form cannot be sent. A content blocker may be stopping challenges.cloudflare.com.',
  'contact.error.tooMany':
    'Too many messages are being sent right now. Please try again in a minute.',
  'contact.error.limited':
    'You sent a message a few minutes ago. You can send another in {minutes} min.',
  'contact.error.generic':
    'Something went wrong and your message was not sent. Please try again later.',
} as const;

export type UIStrings = Record<keyof typeof en, string>;
export type UIKey = keyof typeof en;

export default en;

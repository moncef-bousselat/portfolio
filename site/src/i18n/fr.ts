import type { UIStrings } from './en';

/**
 * French UI strings. Typed as `UIStrings`, so this object must cover every key
 * English defines - omitting one fails `astro check`.
 */
const fr: UIStrings = {
  'site.title': 'Moncef Bousselat',
  'site.role': 'Ingénieur Cloud & DevOps',

  'site.tagline':
    'Je conçois et exploite des infrastructures cloud au quotidien, et je collectionne les projets personnels le reste du temps.',

  'nav.label': 'Principal',
  'nav.home': 'Accueil',
  'nav.journey': 'Parcours',
  'nav.projects': 'Projets',

  'hero.cta.journey': 'Voir le parcours',
  'hero.cta.projects': 'Voir les projets',

  'journey.heading': 'Parcours',
  'journey.intro':
    'Postes, diplômes et certifications, du plus récent au plus ancien. Ouvrez une entrée pour le détail.',
  'journey.ongoing': "Aujourd'hui",
  'journey.relatedProjects': 'Projets associés',
  'journey.kind.work': 'Expérience',
  'journey.kind.education': 'Formation',
  'journey.kind.certification': 'Certification',
  'journey.kind.other': 'Autre',
  'journey.credential': 'Voir la certification',

  'projects.heading': 'Projets',
  'projects.intro':
    "Les travaux d'infrastructure d'abord. Les projets data et machine learning plus anciens sont regroupés à part.",
  'projects.category.cloud': 'Cloud & Infrastructure',
  'projects.category.data-ai': 'Data & IA',
  'projects.category.development': 'Développement',
  'projects.status.active': 'En cours',
  'projects.status.completed': 'Terminé',
  'projects.status.archived': 'Archivé',
  'projects.link.repo': 'Dépôt',
  'projects.link.demo': 'Démo',
  'projects.link.article': 'Article',
  'projects.link.other': 'Lien',
  'projects.readMore': 'En savoir plus',
  'projects.openDetails': 'Ouvrir les détails de',
  'projects.close': 'Fermer',
  'projects.builtWith': 'Technologies',
  'projects.empty': 'Rien pour le moment.',

  'fallback.notice':
    "Cette entrée n'est pas encore traduite en français : la version anglaise est affichée.",

  'nav.writing': 'Écrits',
  'nav.contact': 'Contact',

  'writing.heading': 'Écrits',
  'writing.intro': 'Tutoriels, articles et notes plus courtes. Filtrez par type ou par mot-clé.',
  'writing.type.tutorial': 'Tutoriel',
  'writing.type.article': 'Article',
  'writing.type.note': 'Note',
  'writing.byType': 'Par type',
  'writing.byTag': 'Par mot-clé',
  'writing.all': 'Tous les écrits',
  'writing.minRead': 'min de lecture',
  'writing.published': 'Publié le',
  'writing.updated': 'Mis à jour le',
  'writing.draft': 'Brouillon',
  'writing.toc': 'Sur cette page',
  'writing.empty': 'Rien de publié ici pour le moment.',
  'writing.feed': 'Flux RSS',
  'writing.feedDescription':
    "Tutoriels, articles et notes sur l'infrastructure cloud et le DevOps.",
  'writing.taggedWith': 'Mot-clé',
  'writing.ofType': 'Type',

  'cv.download': 'Télécharger le CV',
  'cv.downloadLang': 'CV (français)',

  'link.newTab': '(ouvre dans un nouvel onglet)',

  'skip.content': 'Aller au contenu',

  'lang.label': 'Langue',
  'lang.current': 'Langue actuelle',

  'footer.sourceCode': 'Code source',

  'notFound.title': 'Page introuvable',
  'notFound.body':
    "Il n'y a rien à cette adresse. La page a peut-être été déplacée, ou le lien est erroné.",
  'notFound.home': "Retour à la page d'accueil",

  'contact.heading': 'Contact',
  'contact.intro':
    'Une question sur un projet, une opportunité, ou quelque chose que vous avez lu ici ? Écrivez-moi, je vous répondrai par e-mail.',
  'contact.name': 'Nom',
  'contact.email': 'E-mail',
  'contact.message': 'Message',
  'contact.messageHint': "Jusqu'à {max} caractères.",
  'contact.honeypot': 'Laissez ce champ vide',
  'contact.submit': 'Envoyer le message',
  'contact.sending': 'Envoi…',
  'contact.noscript':
    'Ce formulaire a besoin de JavaScript pour sa vérification anti-spam, désactivé dans votre navigateur.',
  'contact.elsewhere': 'Vous préférez un autre moyen ? Je suis aussi sur',
  'contact.success.heading': 'Message envoyé',
  'contact.success.body': "Merci pour votre message. Je vous répondrai à l'adresse indiquée.",
  'contact.error.name.required': 'Indiquez votre nom.',
  'contact.error.email.required': 'Indiquez votre adresse e-mail.',
  'contact.error.email.invalid': 'Indiquez une adresse e-mail du type nom@exemple.fr.',
  'contact.error.message.required': 'Écrivez un message.',
  'contact.error.tooLong': 'Ce texte est trop long.',
  'contact.error.invalidChars': 'Ce texte contient des caractères qui ne peuvent pas être envoyés.',
  'contact.error.fix': 'Veuillez corriger les champs signalés.',
  'contact.error.challengePending':
    "La vérification anti-spam n'est pas encore terminée. Patientez un instant, puis renvoyez.",
  'contact.error.challenge': 'La vérification anti-spam a échoué. Veuillez réessayer.',
  'contact.error.challengeLoad':
    "La vérification anti-spam n'a pas pu se charger, le formulaire ne peut donc pas être envoyé. Un bloqueur de contenu empêche peut-être challenges.cloudflare.com.",
  'contact.error.tooMany':
    'Trop de messages sont envoyés en ce moment. Veuillez réessayer dans une minute.',
  'contact.error.limited':
    'Vous avez envoyé un message il y a quelques minutes. Vous pourrez en envoyer un autre dans {minutes} min.',
  'contact.error.generic':
    "Une erreur s'est produite et votre message n'a pas été envoyé. Veuillez réessayer plus tard.",
};

export default fr;

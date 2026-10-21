// Planned CRM areas beyond lead identification. Shown in the navigation as disabled sections.
export type FutureSection = {
  key: string;
  title: string;
  icon: string;
  summary: string;
  features: string[];
  needs: string;
};

export const FUTURE_SECTIONS: FutureSection[] = [
  {
    key: "outreach",
    title: "Outreach campaigns",
    icon: "✉",
    summary: "Mail, email and SMS sequences to owners of saved leads, with opt-out handling.",
    features: [
      "Owner mailing letters from TCAD mailing addresses",
      "Email / SMS sequences with templates",
      "Do-not-contact and opt-out lists",
      "Reply tracking on the lead timeline",
    ],
    needs: "A messaging provider and consent records; outbound messaging is out of scope for this release.",
  },
  {
    key: "estimates",
    title: "Estimates & proposals",
    icon: "▤",
    summary: "Roof measurements, material options and e-signed proposals attached to a lead.",
    features: [
      "Roof area from aerial measurement",
      "Good / better / best material options",
      "PDF proposal with e-signature",
      "Proposal status moves the lead stage",
    ],
    needs: "A measurement source and a document-signing service.",
  },
  {
    key: "jobs",
    title: "Jobs & crews",
    icon: "⚒",
    summary: "Turn won leads into scheduled jobs with crews, materials and permit filing.",
    features: [
      "Crew calendar and job board",
      "Material orders",
      "Permit application checklist per jurisdiction",
      "Photo log and completion sign-off",
    ],
    needs: "Scheduling and supplier integrations.",
  },
  {
    key: "claims",
    title: "Insurance claims",
    icon: "☂",
    summary: "Storm-damage claim tracking linked to NOAA hail events on the property.",
    features: [
      "Claim number, adjuster and carrier",
      "Hail event evidence from NOAA reports",
      "Supplement tracking",
      "Payment milestones",
    ],
    needs: "Carrier and adjuster workflow agreements.",
  },
  {
    key: "routes",
    title: "Canvassing routes",
    icon: "➶",
    summary: "Door-knocking routes through the best leads in a neighborhood.",
    features: [
      "Route optimization over selected leads",
      "Mobile check-ins with outcomes",
      "Territory assignment per rep",
    ],
    needs: "A routing service and a mobile client.",
  },
  {
    key: "reports",
    title: "Reports",
    icon: "▦",
    summary: "Pipeline conversion, lead source performance and rep activity.",
    features: [
      "Stage conversion funnel",
      "Win rate by lead signal (roof age, open permit, hail)",
      "Activity by rep",
      "Export to CSV",
    ],
    needs: "Enough lead history to report on.",
  },
];

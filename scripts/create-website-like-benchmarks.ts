import { mkdir, rm, writeFile } from "fs/promises";
import path from "path";
import { randomUUID } from "crypto";

type Shape =
  | { type: "path"; d: string }
  | { type: "line"; x1: number; y1: number; x2: number; y2: number }
  | { type: "circle"; cx: number; cy: number; r: number };

interface BenchmarkSpec {
  slug: string;
  title: string;
  transcriptText: string;
  canvasWidth: number;
  canvasHeight: number;
  shapes: Shape[];
  labels: Array<{ text: string; x: number; y: number; stemToY?: number }>;
}

const SESSION_ROOT = path.join(process.cwd(), "data", "sessions");
const BENCHMARK_ROOT = path.join(process.cwd(), "data", "website-benchmarks");

function roughBlob(x: number, y: number, width: number, height: number) {
  const x2 = x + width;
  const y2 = y + height;
  const xm = x + width * 0.52;
  const ym = y + height * 0.52;
  return {
    type: "path" as const,
    d: [
      `M ${x + width * 0.18} ${y + height * 0.12}`,
      `C ${x + width * 0.38} ${y - height * 0.04}, ${x + width * 0.7} ${y + height * 0.02}, ${x2 - width * 0.06} ${y + height * 0.18}`,
      `C ${x2 + width * 0.02} ${ym - height * 0.08}, ${x2 - width * 0.03} ${ym + height * 0.2}, ${x2 - width * 0.22} ${y2 - height * 0.08}`,
      `C ${xm + width * 0.12} ${y2 + height * 0.08}, ${xm - width * 0.18} ${y2 + height * 0.02}, ${x + width * 0.14} ${y2 - height * 0.1}`,
      `C ${x - width * 0.02} ${ym + height * 0.12}, ${x - width * 0.01} ${ym - height * 0.12}, ${x + width * 0.18} ${y + height * 0.12}`
    ].join(" ")
  };
}

function roughPanel(x: number, y: number, width: number, height: number, options?: { tilt?: number; bow?: number }) {
  const tilt = options?.tilt ?? 0;
  const bow = options?.bow ?? 0;
  const x2 = x + width;
  const y2 = y + height;
  return {
    type: "path" as const,
    d: [
      `M ${x + 8} ${y + 8}`,
      `L ${x2 - 26} ${y + 8 + bow}`,
      `Q ${x2 + 12} ${y + 12 + bow * 0.5}, ${x2 - 10} ${y2 - 14}`,
      `L ${x + 18 + tilt} ${y2 + 6}`,
      `Q ${x - 16 + tilt * 0.3} ${y2 + 4}, ${x - 10} ${y2 - 18}`,
      `L ${x - 10} ${y + 6}`,
      `Q ${x - 8} ${y - 12}, ${x + 8} ${y + 8}`
    ].join(" ")
  };
}

function roughStrip(x: number, y: number, width: number, height: number) {
  const x2 = x + width;
  const y2 = y + height;
  return {
    type: "path" as const,
    d: [
      `M ${x + 10} ${y + 8}`,
      `L ${x2 - 12} ${y + 10}`,
      `Q ${x2 + 6} ${y + 12}, ${x2 - 4} ${y2 - 10}`,
      `L ${x + 18} ${y2 - 4}`,
      `Q ${x - 6} ${y2 + 2}, ${x + 10} ${y + 8}`
    ].join(" ")
  };
}

function roughRail(x: number, y: number, width: number, height: number) {
  const x2 = x + width;
  const y2 = y + height;
  return {
    type: "path" as const,
    d: [
      `M ${x + 10} ${y + 6}`,
      `L ${x2 - 10} ${y + 6}`,
      `Q ${x2 + 4} ${y + 10}, ${x2 - 2} ${y2 - 8}`,
      `L ${x + 18} ${y2 - 2}`,
      `Q ${x - 8} ${y2 + 2}, ${x + 10} ${y + 6}`
    ].join(" ")
  };
}

function panelLabel(text: string, x: number, y: number, stemToY?: number) {
  return { text, x, y, stemToY };
}

type RoundKey = "a" | "b" | "c" | "d" | "e";

function spokenTranscript(...lines: string[]) {
  return lines.join(" ");
}

function buildRoundASpecs(): BenchmarkSpec[] {
  return [
    {
      slug: "derek-personal-page",
      title: "Website-Like Derek Personal Page",
      transcriptText:
        "Create a personal page for Derek with a large hero portrait at the top, a Derek title near the center, a self introduction block, a selected work band, and a compact contact note at the bottom.",
      canvasWidth: 1280,
      canvasHeight: 720,
      shapes: [
        roughBlob(300, 26, 760, 278),
        roughPanel(370, 322, 590, 244, { bow: -6 }),
        roughStrip(428, 586, 478, 56),
        roughStrip(940, 546, 170, 94)
      ],
      labels: [
        panelLabel("hero portrait", 680, 308, 168),
        panelLabel("Derek title", 684, 290, 332),
        panelLabel("personal page", 290, 444, 444),
        panelLabel("self introduction", 702, 610, 540),
        panelLabel("contact note", 1024, 514, 548)
      ]
    },
    {
      slug: "founder-biography-page",
      title: "Website-Like Founder Biography Page",
      transcriptText:
        "Create a founder biography page with a large portrait or shape at the top, a founder name title, a biography panel, a timeline or principles strip, and a speaking or contact note.",
      canvasWidth: 1280,
      canvasHeight: 720,
      shapes: [
        roughBlob(256, 34, 820, 250),
        roughPanel(366, 314, 620, 250, { tilt: 8 }),
        roughStrip(410, 582, 524, 52),
        roughStrip(968, 528, 160, 102)
      ],
      labels: [
        panelLabel("portrait", 690, 296, 160),
        panelLabel("founder name", 708, 276, 320),
        panelLabel("biography page", 284, 444, 444),
        panelLabel("biography", 688, 602, 546),
        panelLabel("speaking note", 1046, 494, 532)
      ]
    },
    {
      slug: "studio-portfolio-home",
      title: "Website-Like Studio Portfolio Home",
      transcriptText:
        "Create a studio portfolio homepage with a top hero visual, a studio title, an intro statement, a selected projects panel, and a contact or availability strip.",
      canvasWidth: 1280,
      canvasHeight: 720,
      shapes: [
        roughBlob(288, 30, 780, 256),
        roughPanel(332, 314, 690, 216, { bow: 4 }),
        roughStrip(366, 550, 620, 60),
        roughStrip(996, 510, 136, 112)
      ],
      labels: [
        panelLabel("hero visual", 674, 294, 162),
        panelLabel("studio title", 666, 274, 314),
        panelLabel("portfolio home", 252, 430, 430),
        panelLabel("selected projects", 666, 576, 518),
        panelLabel("availability", 1062, 478, 516)
      ]
    },
    {
      slug: "product-launch-landing",
      title: "Website-Like Product Launch Landing",
      transcriptText:
        "Create a product launch landing page with a product hero at the top, a launch title, a features and proof section, a product demo area, and a waitlist CTA band.",
      canvasWidth: 1280,
      canvasHeight: 720,
      shapes: [
        roughBlob(300, 40, 760, 236),
        roughPanel(246, 308, 786, 228, { tilt: 6 }),
        roughStrip(298, 560, 734, 58),
        roughStrip(1050, 470, 108, 154)
      ],
      labels: [
        panelLabel("product hero", 682, 290, 156),
        panelLabel("launch title", 686, 272, 312),
        panelLabel("features + proof", 236, 430, 430),
        panelLabel("demo area", 684, 584, 536),
        panelLabel("waitlist cta", 1100, 438, 470)
      ]
    },
    {
      slug: "festival-program-microsite",
      title: "Website-Like Festival Program Microsite",
      transcriptText:
        "Create a festival microsite with a poster hero at the top, a festival title, a schedule panel, a lineup or program strip, and a buy tickets note.",
      canvasWidth: 1280,
      canvasHeight: 720,
      shapes: [
        roughBlob(284, 36, 788, 250),
        roughPanel(332, 316, 716, 206, { bow: -2 }),
        roughStrip(366, 546, 646, 62),
        roughStrip(1040, 498, 126, 124)
      ],
      labels: [
        panelLabel("poster hero", 680, 300, 164),
        panelLabel("festival title", 690, 280, 316),
        panelLabel("schedule", 308, 424, 424),
        panelLabel("lineup", 690, 580, 524),
        panelLabel("buy tickets", 1102, 464, 500)
      ]
    },
    {
      slug: "subscription-landing",
      title: "Website-Like Subscription Landing",
      transcriptText:
        "Create a subscription landing page with a hero product area, a plan title, plan details, testimonials or comparison content, and an email signup band.",
      canvasWidth: 1280,
      canvasHeight: 720,
      shapes: [
        roughBlob(294, 38, 774, 246),
        roughPanel(308, 314, 730, 218, { tilt: -6 }),
        roughStrip(338, 554, 684, 58),
        roughStrip(1038, 514, 140, 112)
      ],
      labels: [
        panelLabel("hero product", 692, 296, 164),
        panelLabel("plan title", 684, 278, 318),
        panelLabel("plan details", 284, 438, 438),
        panelLabel("testimonials", 690, 578, 532),
        panelLabel("email signup", 1110, 480, 516)
      ]
    },
    {
      slug: "editorial-homepage",
      title: "Website-Like Editorial Homepage",
      transcriptText:
        "Create an editorial homepage with a large masthead area, a lead story title, a main story panel, a secondary stories strip, and a newsletter signup note.",
      canvasWidth: 1280,
      canvasHeight: 720,
      shapes: [
        roughBlob(240, 26, 858, 246),
        roughPanel(302, 304, 764, 218, { bow: 2 }),
        roughStrip(334, 546, 704, 60),
        roughStrip(1052, 502, 116, 122)
      ],
      labels: [
        panelLabel("masthead", 666, 288, 158),
        panelLabel("lead story title", 700, 270, 302),
        panelLabel("main story", 282, 428, 428),
        panelLabel("secondary stories", 700, 580, 526),
        panelLabel("newsletter", 1110, 470, 504)
      ]
    },
    {
      slug: "analytics-dashboard",
      title: "Website-Like Analytics Dashboard",
      transcriptText:
        "Create an analytics dashboard with a sidebar area, a dashboard title bar, a big chart panel, a metrics strip, and an activity or filters note.",
      canvasWidth: 1280,
      canvasHeight: 720,
      shapes: [
        roughRail(92, 102, 180, 480),
        roughStrip(320, 54, 682, 64),
        roughPanel(334, 148, 682, 284, { bow: -4 }),
        roughStrip(348, 462, 648, 58),
        roughStrip(1028, 190, 142, 330)
      ],
      labels: [
        panelLabel("sidebar", 184, 72, 136),
        panelLabel("dashboard title", 662, 20, 54),
        panelLabel("chart panel", 676, 444, 276),
        panelLabel("metrics strip", 676, 540, 492),
        panelLabel("activity / filters", 1100, 160, 224)
      ]
    },
    {
      slug: "marketplace-browse-page",
      title: "Website-Like Marketplace Browse Page",
      transcriptText:
        "Create a marketplace browse page with a header and search area, a marketplace title, a product grid panel, a filters rail, and a cart or summary note.",
      canvasWidth: 1280,
      canvasHeight: 720,
      shapes: [
        roughStrip(284, 40, 824, 86),
        roughRail(96, 162, 186, 418),
        roughPanel(318, 154, 682, 328, { tilt: 4 }),
        roughStrip(344, 512, 640, 72),
        roughStrip(1020, 188, 146, 320)
      ],
      labels: [
        panelLabel("header + search", 688, 8, 40),
        panelLabel("marketplace title", 694, 126, 154),
        panelLabel("filters", 186, 126, 162),
        panelLabel("product grid", 666, 500, 312),
        panelLabel("cart summary", 1096, 158, 220)
      ]
    },
    {
      slug: "account-settings-page",
      title: "Website-Like Account Settings Page",
      transcriptText:
        "Create an account settings page with a top title bar, a settings rail, a profile section, a security or billing section, and a sticky save note.",
      canvasWidth: 1280,
      canvasHeight: 720,
      shapes: [
        roughStrip(304, 44, 790, 74),
        roughRail(98, 156, 198, 410),
        roughPanel(330, 160, 430, 196, { bow: 2 }),
        roughPanel(790, 160, 294, 248, { bow: -2 }),
        roughStrip(336, 540, 748, 62)
      ],
      labels: [
        panelLabel("title bar", 690, 12, 44),
        panelLabel("settings rail", 188, 124, 158),
        panelLabel("profile section", 548, 378, 252),
        panelLabel("security / billing", 934, 430, 286),
        panelLabel("save note", 700, 510, 540)
      ]
    }
  ];
}

function buildRoundBSpecs(): BenchmarkSpec[] {
  return [
    {
      slug: "researcher-profile-page",
      title: "Website-Like Researcher Profile Page",
      transcriptText:
        "Create a researcher profile page with a portrait or abstract hero, a researcher name title, a short biography panel, a publications strip, and a contact or speaking note.",
      canvasWidth: 1280,
      canvasHeight: 720,
      shapes: [
        roughBlob(120, 84, 360, 260),
        roughStrip(560, 74, 486, 88),
        roughPanel(514, 196, 560, 238, { tilt: -8 }),
        roughStrip(176, 500, 748, 64),
        roughStrip(960, 500, 148, 112)
      ],
      labels: [
        panelLabel("portrait / hero", 298, 352, 208),
        panelLabel("researcher name", 806, 34, 74),
        panelLabel("biography panel", 798, 452, 310),
        panelLabel("publications strip", 556, 470, 500),
        panelLabel("contact note", 1032, 466, 504)
      ]
    },
    {
      slug: "architecture-portfolio-page",
      title: "Website-Like Architecture Portfolio Page",
      transcriptText:
        "Create an architecture portfolio page with a large featured image area, an architect title, a project story panel, a case studies strip, and an inquiry note.",
      canvasWidth: 1280,
      canvasHeight: 720,
      shapes: [
        roughStrip(104, 78, 300, 114),
        roughBlob(470, 46, 642, 262),
        roughPanel(118, 248, 404, 292, { bow: 4 }),
        roughStrip(560, 360, 518, 202),
        roughStrip(946, 578, 184, 72)
      ],
      labels: [
        panelLabel("architect title", 254, 42, 78),
        panelLabel("featured image", 796, 326, 182),
        panelLabel("project story", 320, 556, 388),
        panelLabel("case studies", 814, 584, 460),
        panelLabel("inquiry", 1038, 544, 578)
      ]
    },
    {
      slug: "wellness-booking-page",
      title: "Website-Like Wellness Booking Page",
      transcriptText:
        "Create a wellness booking page with a calm hero image area, a retreat title, an availability section, a treatment or class strip, and a booking note.",
      canvasWidth: 1280,
      canvasHeight: 720,
      shapes: [
        roughStrip(168, 54, 450, 82),
        roughBlob(110, 168, 466, 270),
        roughPanel(664, 154, 364, 276, { tilt: 6 }),
        roughStrip(118, 506, 692, 66),
        roughStrip(868, 506, 212, 112)
      ],
      labels: [
        panelLabel("retreat title", 390, 16, 54),
        panelLabel("hero image", 332, 456, 248),
        panelLabel("availability", 846, 446, 290),
        panelLabel("classes / treatments", 456, 474, 506),
        panelLabel("booking note", 974, 474, 506)
      ]
    },
    {
      slug: "restaurant-reservation-page",
      title: "Website-Like Restaurant Reservation Page",
      transcriptText:
        "Create a restaurant reservation page with a hero dining image, a restaurant title, a menu or story section, a reservations strip, and a booking note.",
      canvasWidth: 1280,
      canvasHeight: 720,
      shapes: [
        roughBlob(200, 42, 882, 214),
        roughStrip(380, 230, 430, 74),
        roughPanel(128, 320, 456, 222, { bow: 2 }),
        roughPanel(640, 320, 352, 222, { bow: -2 }),
        roughStrip(208, 586, 700, 62)
      ],
      labels: [
        panelLabel("hero dining image", 652, 264, 150),
        panelLabel("restaurant title", 596, 196, 230),
        panelLabel("menu / story", 356, 554, 420),
        panelLabel("booking note", 822, 554, 420),
        panelLabel("reservations strip", 558, 556, 586)
      ]
    },
    {
      slug: "nonprofit-campaign-page",
      title: "Website-Like Nonprofit Campaign Page",
      transcriptText:
        "Create a nonprofit campaign page with a hero cause image, a campaign title, a story or impact panel, a donation progress strip, and a donate note.",
      canvasWidth: 1280,
      canvasHeight: 720,
      shapes: [
        roughBlob(118, 68, 432, 240),
        roughStrip(620, 72, 420, 104),
        roughPanel(102, 356, 628, 220, { bow: 4 }),
        roughStrip(790, 326, 276, 92),
        roughStrip(808, 456, 236, 124)
      ],
      labels: [
        panelLabel("cause image", 334, 328, 182),
        panelLabel("campaign title", 830, 38, 72),
        panelLabel("story / impact", 426, 594, 474),
        panelLabel("donation progress", 926, 292, 326),
        panelLabel("donate note", 930, 424, 456)
      ]
    },
    {
      slug: "course-launch-page",
      title: "Website-Like Course Launch Page",
      transcriptText:
        "Create a course launch page with a hero instructor area, a course title, a syllabus or benefits section, a lesson overview strip, and an enrollment note.",
      canvasWidth: 1280,
      canvasHeight: 720,
      shapes: [
        roughPanel(90, 82, 450, 326, { bow: -2 }),
        roughBlob(618, 52, 442, 220),
        roughStrip(598, 260, 276, 78),
        roughStrip(114, 478, 714, 72),
        roughStrip(892, 424, 198, 134)
      ],
      labels: [
        panelLabel("course title", 314, 50, 84),
        panelLabel("instructor hero", 838, 286, 176),
        panelLabel("enrollment note", 734, 228, 260),
        panelLabel("syllabus / benefits", 470, 442, 478),
        panelLabel("lesson overview", 1002, 392, 424)
      ]
    },
    {
      slug: "finance-overview-dashboard",
      title: "Website-Like Finance Overview Dashboard",
      transcriptText:
        "Create a finance dashboard with a sidebar area, a finance title bar, a portfolio overview panel, a metrics strip, and a alerts or activity note.",
      canvasWidth: 1280,
      canvasHeight: 720,
      shapes: [
        roughRail(90, 104, 186, 476),
        roughStrip(324, 48, 694, 72),
        roughPanel(342, 148, 676, 286, { bow: 4 }),
        roughStrip(356, 462, 648, 62),
        roughStrip(1040, 186, 134, 334)
      ],
      labels: [
        panelLabel("sidebar", 184, 72, 138),
        panelLabel("finance title", 664, 18, 48),
        panelLabel("portfolio overview", 678, 444, 286),
        panelLabel("metrics strip", 682, 544, 494),
        panelLabel("alerts / activity", 1110, 154, 190)
      ]
    },
    {
      slug: "team-admin-settings",
      title: "Website-Like Team Admin Settings",
      transcriptText:
        "Create a team admin settings page with a title bar, a team settings rail, a members or roles section, a permissions section, and a save changes note.",
      canvasWidth: 1280,
      canvasHeight: 720,
      shapes: [
        roughStrip(316, 44, 778, 72),
        roughRail(96, 158, 202, 404),
        roughPanel(336, 164, 416, 186, { bow: -2 }),
        roughPanel(784, 164, 314, 250, { bow: 2 }),
        roughStrip(338, 542, 760, 62)
      ],
      labels: [
        panelLabel("title bar", 690, 14, 44),
        panelLabel("team settings rail", 198, 126, 160),
        panelLabel("members / roles", 548, 372, 248),
        panelLabel("permissions", 946, 432, 286),
        panelLabel("save changes", 706, 510, 542)
      ]
    },
    {
      slug: "music-player-app",
      title: "Website-Like Music Player App",
      transcriptText:
        "Create a music player app with a navigation rail, an album art hero, a now playing title area, a queue or recommendations strip, and a player controls band.",
      canvasWidth: 1280,
      canvasHeight: 720,
      shapes: [
        roughRail(92, 114, 180, 420),
        roughBlob(342, 44, 420, 258),
        roughPanel(792, 86, 294, 232, { bow: -2 }),
        roughStrip(338, 344, 744, 168),
        roughStrip(326, 564, 770, 72)
      ],
      labels: [
        panelLabel("navigation rail", 186, 82, 114),
        panelLabel("album art hero", 552, 318, 174),
        panelLabel("now playing title", 938, 52, 86),
        panelLabel("queue / recommendations", 712, 526, 428),
        panelLabel("player controls", 714, 534, 564)
      ]
    },
    {
      slug: "travel-planner-page",
      title: "Website-Like Travel Planner Page",
      transcriptText:
        "Create a travel planner page with a destination hero, a trip title, an itinerary panel, a planning strip, and a booking or save note.",
      canvasWidth: 1280,
      canvasHeight: 720,
      shapes: [
        roughStrip(104, 78, 360, 96),
        roughBlob(632, 54, 450, 226),
        roughPanel(108, 246, 426, 292, { bow: 2 }),
        roughStrip(594, 336, 428, 126),
        roughStrip(612, 520, 442, 82)
      ],
      labels: [
        panelLabel("trip title", 280, 36, 78),
        panelLabel("destination hero", 854, 300, 176),
        panelLabel("itinerary", 324, 560, 420),
        panelLabel("planning strip", 804, 302, 336),
        panelLabel("save / book note", 838, 490, 522)
      ]
    }
  ];
}

function buildRoundCSpecs(): BenchmarkSpec[] {
  return [
    {
      slug: "historian-journal-homepage",
      title: "Website-Like Historian Journal Homepage",
      transcriptText:
        "Create a historian journal homepage with a portrait or archive hero, a historian name title, an abstract or journal intro panel, a recent essays strip, and a lectures or contact note.",
      canvasWidth: 1280,
      canvasHeight: 720,
      shapes: [
        roughBlob(128, 74, 340, 256),
        roughStrip(536, 66, 494, 96),
        roughPanel(512, 196, 566, 224, { tilt: -4 }),
        roughStrip(164, 494, 760, 74),
        roughStrip(958, 500, 154, 108)
      ],
      labels: [
        panelLabel("archive hero", 296, 344, 206),
        panelLabel("historian title", 778, 28, 66),
        panelLabel("journal intro", 790, 438, 310),
        panelLabel("recent essays", 554, 462, 494),
        panelLabel("lectures note", 1038, 468, 500)
      ]
    },
    {
      slug: "industrial-design-portfolio",
      title: "Website-Like Industrial Design Portfolio",
      transcriptText:
        "Create an industrial design portfolio page with a featured object image, a studio title, a project statement panel, a selected cases strip, and an inquiry note.",
      canvasWidth: 1280,
      canvasHeight: 720,
      shapes: [
        roughBlob(468, 42, 620, 250),
        roughStrip(92, 82, 328, 112),
        roughPanel(114, 244, 410, 286, { bow: 4 }),
        roughStrip(572, 360, 500, 204),
        roughStrip(960, 586, 174, 70)
      ],
      labels: [
        panelLabel("studio title", 258, 46, 82),
        panelLabel("featured object", 796, 316, 170),
        panelLabel("project statement", 324, 548, 392),
        panelLabel("selected cases", 820, 584, 464),
        panelLabel("inquiry", 1046, 554, 586)
      ]
    },
    {
      slug: "boutique-hotel-booking",
      title: "Website-Like Boutique Hotel Booking",
      transcriptText:
        "Create a boutique hotel booking page with a room or lobby hero image, a hotel title, an availability panel, an amenities strip, and a reserve note.",
      canvasWidth: 1280,
      canvasHeight: 720,
      shapes: [
        roughBlob(112, 162, 486, 262),
        roughStrip(162, 56, 442, 84),
        roughPanel(666, 154, 360, 278, { tilt: 6 }),
        roughStrip(116, 504, 710, 66),
        roughStrip(884, 502, 210, 116)
      ],
      labels: [
        panelLabel("hotel title", 386, 18, 56),
        panelLabel("hero image", 350, 440, 252),
        panelLabel("availability", 848, 448, 294),
        panelLabel("amenities", 458, 472, 504),
        panelLabel("reserve note", 984, 470, 502)
      ]
    },
    {
      slug: "gallery-opening-microsite",
      title: "Website-Like Gallery Opening Microsite",
      transcriptText:
        "Create a gallery opening microsite with a poster hero, an exhibition title, a schedule or details panel, an artists strip, and an RSVP note.",
      canvasWidth: 1280,
      canvasHeight: 720,
      shapes: [
        roughBlob(248, 36, 806, 234),
        roughStrip(384, 228, 440, 74),
        roughPanel(136, 322, 474, 220, { bow: 2 }),
        roughPanel(664, 322, 338, 216, { bow: -2 }),
        roughStrip(216, 584, 700, 60)
      ],
      labels: [
        panelLabel("poster hero", 658, 286, 158),
        panelLabel("exhibition title", 604, 194, 228),
        panelLabel("details / schedule", 382, 554, 422),
        panelLabel("rsvp note", 838, 552, 422),
        panelLabel("artists strip", 566, 554, 584)
      ]
    },
    {
      slug: "climate-relief-campaign-page",
      title: "Website-Like Climate Relief Campaign Page",
      transcriptText:
        "Create a climate relief campaign page with a cause hero image, a campaign title, an impact story panel, a funding progress strip, and a donate note.",
      canvasWidth: 1280,
      canvasHeight: 720,
      shapes: [
        roughBlob(116, 72, 442, 238),
        roughStrip(626, 74, 432, 104),
        roughPanel(112, 350, 634, 214, { bow: 4 }),
        roughStrip(804, 324, 268, 88),
        roughStrip(816, 452, 230, 126)
      ],
      labels: [
        panelLabel("cause hero", 340, 330, 182),
        panelLabel("campaign title", 838, 40, 74),
        panelLabel("impact story", 432, 580, 468),
        panelLabel("funding progress", 938, 290, 324),
        panelLabel("donate note", 930, 420, 452)
      ]
    },
    {
      slug: "membership-pricing-page",
      title: "Website-Like Membership Pricing Page",
      transcriptText:
        "Create a membership pricing page with a product hero, a plans title, a comparison panel, a benefits strip, and an email signup note.",
      canvasWidth: 1280,
      canvasHeight: 720,
      shapes: [
        roughBlob(286, 42, 780, 228),
        roughStrip(330, 236, 416, 72),
        roughPanel(214, 326, 640, 212, { tilt: -4 }),
        roughStrip(246, 566, 606, 62),
        roughStrip(888, 374, 206, 190)
      ],
      labels: [
        panelLabel("product hero", 682, 286, 156),
        panelLabel("plans title", 540, 202, 236),
        panelLabel("comparison panel", 532, 552, 432),
        panelLabel("benefits strip", 548, 536, 566),
        panelLabel("signup note", 992, 342, 374)
      ]
    },
    {
      slug: "logistics-ops-dashboard",
      title: "Website-Like Logistics Ops Dashboard",
      transcriptText:
        "Create a logistics dashboard with a sidebar area, a logistics title bar, a route overview panel, a metrics strip, and a alerts or shipments note.",
      canvasWidth: 1280,
      canvasHeight: 720,
      shapes: [
        roughRail(92, 104, 184, 474),
        roughStrip(322, 48, 700, 72),
        roughPanel(340, 150, 680, 282, { bow: 4 }),
        roughStrip(356, 462, 648, 62),
        roughStrip(1040, 188, 136, 334)
      ],
      labels: [
        panelLabel("sidebar", 184, 72, 138),
        panelLabel("logistics title", 670, 18, 48),
        panelLabel("route overview", 680, 442, 286),
        panelLabel("metrics strip", 684, 544, 494),
        panelLabel("alerts / shipments", 1112, 154, 188)
      ]
    },
    {
      slug: "privacy-security-settings",
      title: "Website-Like Privacy Security Settings",
      transcriptText:
        "Create a privacy and security settings page with a title bar, a settings rail, an identity section, a security controls section, and a save changes note.",
      canvasWidth: 1280,
      canvasHeight: 720,
      shapes: [
        roughStrip(314, 44, 780, 72),
        roughRail(98, 156, 202, 408),
        roughPanel(338, 160, 420, 188, { bow: -2 }),
        roughPanel(790, 160, 314, 248, { bow: 2 }),
        roughStrip(340, 542, 758, 62)
      ],
      labels: [
        panelLabel("title bar", 692, 14, 44),
        panelLabel("settings rail", 198, 124, 156),
        panelLabel("identity section", 552, 372, 248),
        panelLabel("security controls", 950, 430, 286),
        panelLabel("save changes", 708, 510, 542)
      ]
    },
    {
      slug: "podcast-player-app",
      title: "Website-Like Podcast Player App",
      transcriptText:
        "Create a podcast player app with a navigation rail, a featured episode hero, a now playing title area, a queue or episode list strip, and a playback controls band.",
      canvasWidth: 1280,
      canvasHeight: 720,
      shapes: [
        roughRail(92, 112, 180, 422),
        roughBlob(340, 46, 422, 254),
        roughPanel(792, 88, 294, 228, { bow: -2 }),
        roughStrip(338, 344, 742, 170),
        roughStrip(326, 564, 772, 72)
      ],
      labels: [
        panelLabel("navigation rail", 186, 80, 112),
        panelLabel("featured episode", 554, 316, 174),
        panelLabel("now playing title", 940, 54, 88),
        panelLabel("episode list", 712, 528, 430),
        panelLabel("playback controls", 714, 534, 564)
      ]
    },
    {
      slug: "editorial-magazine-homepage",
      title: "Website-Like Editorial Magazine Homepage",
      transcriptText:
        "Create an editorial magazine homepage with a masthead hero, a lead story title, a main story panel, a secondary stories strip, and a subscribe note.",
      canvasWidth: 1280,
      canvasHeight: 720,
      shapes: [
        roughBlob(230, 30, 856, 238),
        roughStrip(372, 224, 452, 74),
        roughPanel(300, 314, 768, 210, { bow: 2 }),
        roughStrip(334, 548, 704, 60),
        roughStrip(1052, 504, 116, 122)
      ],
      labels: [
        panelLabel("masthead hero", 662, 286, 156),
        panelLabel("lead story title", 600, 190, 224),
        panelLabel("main story", 682, 538, 420),
        panelLabel("secondary stories", 694, 580, 528),
        panelLabel("subscribe note", 1112, 472, 504)
      ]
    }
  ];
}

function buildRoundDSpecs(): BenchmarkSpec[] {
  return [
    {
      slug: "documentary-director-homepage",
      title: "Website-Like Documentary Director Homepage",
      transcriptText: spokenTranscript(
        "Okay, for this one I want it to feel like a personal site for a documentary director, not like a startup founder page.",
        "At the top I want the name really large, and I want some kind of portrait or abstract still off to the left.",
        "Then give me a short introduction in the middle, a strip for selected films lower down, and a small contact note over on the side.",
        "Style-wise I want it calm and cinematic, but still very readable and not overcrowded."
      ),
      canvasWidth: 1280,
      canvasHeight: 720,
      shapes: [
        roughStrip(420, 62, 468, 88),
        roughBlob(112, 110, 326, 252),
        { type: "line", x1: 520, y1: 220, x2: 1088, y2: 220 },
        { type: "line", x1: 148, y1: 500, x2: 980, y2: 500 },
        roughStrip(966, 414, 152, 118)
      ],
      labels: [
        panelLabel("director name", 652, 24, 62),
        panelLabel("portrait / still", 274, 378, 238),
        panelLabel("introduction", 816, 186, 220),
        panelLabel("selected films", 564, 466, 500),
        panelLabel("contact note", 1044, 382, 414)
      ]
    },
    {
      slug: "ceramics-studio-portfolio",
      title: "Website-Like Ceramics Studio Portfolio",
      transcriptText: spokenTranscript(
        "I want this one to be for a ceramics studio.",
        "At the top there should be a featured vessel image or shape, then the studio title, then a project statement on the left, and lower down I want a row for selected works.",
        "Please keep it tactile and elegant, but not another generic beige luxury landing page."
      ),
      canvasWidth: 1280,
      canvasHeight: 720,
      shapes: [
        roughBlob(580, 52, 420, 232),
        roughStrip(124, 74, 324, 98),
        { type: "line", x1: 128, y1: 234, x2: 1068, y2: 234 },
        roughPanel(116, 260, 360, 260, { bow: 2 }),
        { type: "line", x1: 520, y1: 544, x2: 1044, y2: 544 },
        roughStrip(922, 574, 170, 74)
      ],
      labels: [
        panelLabel("studio title", 286, 36, 74),
        panelLabel("featured vessel", 792, 300, 184),
        panelLabel("project statement", 296, 536, 392),
        panelLabel("selected works", 780, 510, 544),
        panelLabel("inquiry", 1008, 542, 574)
      ]
    },
    {
      slug: "surf-lodge-booking-page",
      title: "Website-Like Surf Lodge Booking Page",
      transcriptText: spokenTranscript(
        "This one is a booking page for a surf lodge.",
        "I want the title up top, a big image area for the room or the beach, then on the right I want the booking / availability thing, and below that just a couple of support bits like what's included and a reserve note.",
        "I want it to feel airy and coastal, not packed with text."
      ),
      canvasWidth: 1280,
      canvasHeight: 720,
      shapes: [
        roughStrip(146, 58, 420, 80),
        roughBlob(98, 160, 488, 258),
        roughPanel(680, 158, 340, 270, { tilt: 4 }),
        { type: "line", x1: 124, y1: 522, x2: 844, y2: 522 },
        roughStrip(888, 500, 190, 110)
      ],
      labels: [
        panelLabel("lodge title", 354, 20, 58),
        panelLabel("hero image", 336, 436, 252),
        panelLabel("availability", 854, 446, 294),
        panelLabel("amenities", 478, 488, 522),
        panelLabel("reserve note", 982, 468, 500)
      ]
    },
    {
      slug: "design-summit-microsite",
      title: "Website-Like Design Summit Microsite",
      transcriptText: spokenTranscript(
        "Here I want more of an event page.",
        "Put a big summit title in the hero, maybe a bold graphic shape behind it, then a schedule/details block underneath, an speakers strip, and a little RSVP note off to one side.",
        "Please make it feel energetic and graphic, not like a quiet editorial archive."
      ),
      canvasWidth: 1280,
      canvasHeight: 720,
      shapes: [
        roughBlob(332, 34, 708, 224),
        roughStrip(458, 214, 376, 78),
        roughPanel(154, 312, 462, 212, { bow: -2 }),
        { type: "line", x1: 662, y1: 424, x2: 1062, y2: 424 },
        roughStrip(938, 470, 156, 112)
      ],
      labels: [
        panelLabel("summit title", 650, 180, 214),
        panelLabel("hero graphic", 688, 274, 160),
        panelLabel("schedule / details", 386, 540, 418),
        panelLabel("speakers strip", 860, 390, 424),
        panelLabel("rsvp note", 1016, 438, 470)
      ]
    },
    {
      slug: "neighborhood-food-fund-page",
      title: "Website-Like Neighborhood Food Fund Page",
      transcriptText: spokenTranscript(
        "I want this to be a campaign page for a neighborhood food fund.",
        "Top left should be the main headline and a cause image area, then I want an impact story section, a progress area, and a donation note.",
        "It should feel active and civic, not like a default nonprofit template, and not too text heavy."
      ),
      canvasWidth: 1280,
      canvasHeight: 720,
      shapes: [
        roughBlob(118, 72, 404, 214),
        roughStrip(150, 274, 450, 82),
        roughPanel(116, 372, 600, 208, { bow: 2 }),
        roughStrip(786, 224, 248, 96),
        roughStrip(810, 382, 232, 144)
      ],
      labels: [
        panelLabel("cause image", 322, 306, 176),
        panelLabel("main headline", 366, 240, 274),
        panelLabel("impact story", 420, 594, 474),
        panelLabel("progress", 910, 190, 224),
        panelLabel("donate note", 926, 348, 382)
      ]
    },
    {
      slug: "meal-club-pricing-page",
      title: "Website-Like Meal Club Pricing Page",
      transcriptText: spokenTranscript(
        "For this one I want a pricing page for a meal club.",
        "At the top there should be a clear title and a hero area, then a comparison section for the plans, then a short benefits strip, and finally a signup note.",
        "Make it feel commercial and clear, but not like a bunch of identical pricing cards."
      ),
      canvasWidth: 1280,
      canvasHeight: 720,
      shapes: [
        roughStrip(170, 56, 420, 82),
        roughBlob(582, 44, 442, 212),
        { type: "line", x1: 160, y1: 318, x2: 1086, y2: 318 },
        roughPanel(208, 338, 624, 188, { bow: -4 }),
        roughStrip(854, 372, 200, 176),
        { type: "line", x1: 242, y1: 580, x2: 828, y2: 580 }
      ],
      labels: [
        panelLabel("plans title", 386, 18, 56),
        panelLabel("hero product", 804, 270, 152),
        panelLabel("comparison section", 520, 540, 432),
        panelLabel("signup note", 956, 338, 372),
        panelLabel("benefits strip", 536, 546, 580)
      ]
    },
    {
      slug: "fleet-monitor-dashboard",
      title: "Website-Like Fleet Monitor Dashboard",
      transcriptText: spokenTranscript(
        "This one is definitely a product dashboard.",
        "I want a sidebar on the left, a title bar across the top, a big route or fleet overview in the middle, then a metrics strip, and alerts on the right.",
        "Please make it feel operational and dark, not like an editorial portfolio."
      ),
      canvasWidth: 1280,
      canvasHeight: 720,
      shapes: [
        roughRail(94, 104, 176, 474),
        roughStrip(324, 48, 704, 70),
        roughPanel(344, 150, 678, 278, { bow: 2 }),
        roughStrip(356, 462, 646, 62),
        roughRail(1046, 178, 128, 340)
      ],
      labels: [
        panelLabel("sidebar", 182, 72, 104),
        panelLabel("title bar", 678, 18, 48),
        panelLabel("fleet overview", 684, 442, 284),
        panelLabel("metrics strip", 682, 544, 494),
        panelLabel("alerts", 1110, 144, 178)
      ]
    },
    {
      slug: "workspace-privacy-settings",
      title: "Website-Like Workspace Privacy Settings",
      transcriptText: spokenTranscript(
        "I want a settings page here, specifically for privacy and workspace access.",
        "Give me a title bar, a settings rail on the left, a main identity section, another area for security controls, and then a save changes note at the bottom.",
        "It should look clean and product-like, but not over-designed."
      ),
      canvasWidth: 1280,
      canvasHeight: 720,
      shapes: [
        roughStrip(320, 46, 760, 68),
        roughRail(98, 156, 196, 408),
        roughPanel(338, 158, 424, 188, { bow: -2 }),
        roughPanel(794, 158, 312, 250, { bow: 2 }),
        roughStrip(344, 544, 758, 60)
      ],
      labels: [
        panelLabel("title bar", 700, 16, 46),
        panelLabel("settings rail", 196, 124, 156),
        panelLabel("identity section", 552, 370, 246),
        panelLabel("security controls", 952, 430, 286),
        panelLabel("save note", 710, 512, 544)
      ]
    },
    {
      slug: "ambient-radio-player",
      title: "Website-Like Ambient Radio Player",
      transcriptText: spokenTranscript(
        "This one should feel like a player for ambient radio.",
        "Put navigation on the left, a featured program area in the middle, now playing over on the right, a strip for episodes lower down, and then the controls band at the bottom.",
        "I want it moody and dark and spacious, not packed with little cards."
      ),
      canvasWidth: 1280,
      canvasHeight: 720,
      shapes: [
        roughRail(96, 112, 176, 424),
        roughBlob(356, 52, 404, 236),
        roughStrip(816, 92, 244, 146),
        { type: "line", x1: 338, y1: 384, x2: 1082, y2: 384 },
        roughStrip(334, 564, 764, 68)
      ],
      labels: [
        panelLabel("navigation", 182, 80, 112),
        panelLabel("featured program", 556, 304, 168),
        panelLabel("now playing", 938, 58, 92),
        panelLabel("episode strip", 712, 350, 384),
        panelLabel("controls", 716, 534, 564)
      ]
    },
    {
      slug: "culture-journal-homepage",
      title: "Website-Like Culture Journal Homepage",
      transcriptText: spokenTranscript(
        "I want this to feel like a culture journal homepage.",
        "Give me a big masthead style title, a lead story area, then a main article block, a strip for more stories, and a little subscribe note.",
        "I want it elegant, but I do not want every section boxed up and dense."
      ),
      canvasWidth: 1280,
      canvasHeight: 720,
      shapes: [
        roughBlob(236, 34, 844, 226),
        roughStrip(380, 208, 428, 72),
        roughPanel(304, 314, 760, 206, { bow: 2 }),
        { type: "line", x1: 324, y1: 570, x2: 1034, y2: 570 },
        roughStrip(1052, 476, 118, 122)
      ],
      labels: [
        panelLabel("masthead title", 652, 174, 208),
        panelLabel("lead story", 594, 174, 208),
        panelLabel("main article", 686, 536, 420),
        panelLabel("more stories", 690, 536, 570),
        panelLabel("subscribe note", 1112, 442, 476)
      ]
    }
  ];
}

function buildRoundESpecs(): BenchmarkSpec[] {
  return [
    {
      slug: "independent-filmmaker-journal",
      title: "Website-Like Independent Filmmaker Journal",
      transcriptText: spokenTranscript(
        "I want this to feel like a journal homepage for an independent filmmaker.",
        "Put the filmmaker name really large across the top, then I want a still image area off to the right, a short note about the practice, a strip for films or diary entries lower down, and a very small contact note.",
        "Please keep it cinematic and quiet, but not overly dense and not boxed into a bunch of cards."
      ),
      canvasWidth: 1280,
      canvasHeight: 720,
      shapes: [
        roughStrip(132, 58, 488, 86),
        roughBlob(764, 86, 320, 236),
        { type: "line", x1: 144, y1: 250, x2: 1040, y2: 250 },
        { type: "line", x1: 144, y1: 510, x2: 1030, y2: 510 },
        roughStrip(986, 420, 132, 104)
      ],
      labels: [
        panelLabel("filmmaker name", 376, 24, 58),
        panelLabel("still image", 926, 338, 206),
        panelLabel("practice note", 364, 216, 250),
        panelLabel("films / diary", 520, 474, 510),
        panelLabel("contact note", 1052, 388, 420)
      ]
    },
    {
      slug: "pilates-studio-booking-page",
      title: "Website-Like Pilates Studio Booking Page",
      transcriptText: spokenTranscript(
        "This one should be a booking page for a pilates studio.",
        "I want a clear studio title at the top, a big image area for the room, a class availability or booking thing over on the right, then lower down a small section for what to expect and a reserve note.",
        "Please make it feel fresh and light, but not like another generic beige wellness website."
      ),
      canvasWidth: 1280,
      canvasHeight: 720,
      shapes: [
        roughStrip(146, 54, 386, 80),
        roughBlob(108, 162, 472, 248),
        roughPanel(682, 160, 322, 256, { tilt: 4 }),
        { type: "line", x1: 144, y1: 514, x2: 834, y2: 514 },
        roughStrip(892, 492, 184, 112)
      ],
      labels: [
        panelLabel("studio title", 336, 18, 54),
        panelLabel("room image", 344, 428, 236),
        panelLabel("class availability", 842, 434, 288),
        panelLabel("what to expect", 482, 478, 514),
        panelLabel("reserve note", 984, 458, 492)
      ]
    },
    {
      slug: "community-library-fundraiser",
      title: "Website-Like Community Library Fundraiser",
      transcriptText: spokenTranscript(
        "I want a campaign page for a community library fundraiser.",
        "Top area should have the big headline and one image or illustration area, then I want an impact section, a progress or donation section, and a small volunteer note.",
        "It should feel civic and optimistic, not like a lifeless nonprofit template, and keep the text light."
      ),
      canvasWidth: 1280,
      canvasHeight: 720,
      shapes: [
        roughStrip(134, 64, 404, 92),
        roughBlob(720, 84, 340, 218),
        { type: "line", x1: 144, y1: 246, x2: 1042, y2: 246 },
        roughPanel(140, 292, 420, 214, { bow: 2 }),
        roughStrip(634, 316, 366, 82),
        roughStrip(862, 456, 188, 110)
      ],
      labels: [
        panelLabel("fundraiser headline", 360, 28, 64),
        panelLabel("cause image", 904, 316, 194),
        panelLabel("impact section", 340, 528, 398),
        panelLabel("progress / donate", 824, 282, 316),
        panelLabel("volunteer note", 958, 422, 456)
      ]
    },
    {
      slug: "shipping-operations-board",
      title: "Website-Like Shipping Operations Board",
      transcriptText: spokenTranscript(
        "This should definitely be an operations dashboard for shipping or dispatch.",
        "Give me a title bar across the top, a left rail, then a big live operations area in the middle, some metrics across the lower middle, and alerts or incidents over on the right.",
        "I want it dark and sharp and easy to scan, not decorative."
      ),
      canvasWidth: 1280,
      canvasHeight: 720,
      shapes: [
        roughStrip(330, 46, 690, 74),
        roughRail(94, 120, 186, 454),
        roughPanel(336, 146, 664, 286, { bow: 4 }),
        roughStrip(354, 466, 626, 64),
        roughStrip(1022, 176, 138, 340)
      ],
      labels: [
        panelLabel("title bar", 674, 14, 46),
        panelLabel("left rail", 184, 88, 120),
        panelLabel("live operations", 666, 444, 288),
        panelLabel("metrics", 670, 548, 498),
        panelLabel("alerts / incidents", 1096, 142, 176)
      ]
    },
    {
      slug: "team-permissions-settings",
      title: "Website-Like Team Permissions Settings",
      transcriptText: spokenTranscript(
        "I want a workspace settings page, specifically for team permissions and access.",
        "There should be a title bar at the top, a settings rail on the left, a main permissions section, another section for roles or approvals, and then a save changes area.",
        "Keep it product-like and calm, but not cramped and not covered in little boxed cards."
      ),
      canvasWidth: 1280,
      canvasHeight: 720,
      shapes: [
        roughStrip(320, 44, 772, 72),
        roughRail(98, 154, 206, 420),
        roughPanel(344, 162, 432, 186, { bow: -2 }),
        roughPanel(804, 162, 304, 244, { bow: 2 }),
        roughStrip(346, 542, 760, 64)
      ],
      labels: [
        panelLabel("title bar", 708, 12, 44),
        panelLabel("settings rail", 198, 120, 154),
        panelLabel("permissions", 564, 372, 248),
        panelLabel("roles / approvals", 962, 428, 286),
        panelLabel("save changes", 720, 508, 542)
      ]
    },
    {
      slug: "listening-room-player",
      title: "Website-Like Listening Room Player",
      transcriptText: spokenTranscript(
        "This one should feel like a listening room player for longform audio.",
        "Put the main navigation over on the left, a featured program area in the center, now playing on the right, then a lower strip for episodes, and controls anchored at the bottom.",
        "Make it dark and spacious and beautiful, but don't let it turn into a stack of tiny cards."
      ),
      canvasWidth: 1280,
      canvasHeight: 720,
      shapes: [
        roughRail(94, 108, 182, 420),
        roughBlob(334, 56, 420, 250),
        roughPanel(792, 90, 294, 228, { bow: -2 }),
        { type: "line", x1: 338, y1: 366, x2: 1088, y2: 366 },
        roughStrip(330, 564, 770, 70)
      ],
      labels: [
        panelLabel("navigation", 184, 74, 108),
        panelLabel("featured program", 548, 326, 182),
        panelLabel("now playing", 942, 56, 90),
        panelLabel("episodes", 728, 332, 366),
        panelLabel("controls", 716, 532, 564)
      ]
    },
    {
      slug: "city-culture-journal",
      title: "Website-Like City Culture Journal",
      transcriptText: spokenTranscript(
        "I want a homepage for a city culture journal.",
        "There should be a big masthead title, a lead story area, then a main article block, a strip for more stories, and a small subscribe note.",
        "Make it elegant and readable and not too dense, and please don't box every section."
      ),
      canvasWidth: 1280,
      canvasHeight: 720,
      shapes: [
        roughStrip(286, 42, 690, 84),
        roughBlob(196, 138, 308, 202),
        roughPanel(554, 140, 486, 218, { bow: 2 }),
        { type: "line", x1: 176, y1: 500, x2: 1038, y2: 500 },
        roughStrip(1022, 418, 124, 120)
      ],
      labels: [
        panelLabel("masthead", 638, 10, 42),
        panelLabel("lead story", 354, 360, 240),
        panelLabel("main article", 790, 382, 252),
        panelLabel("more stories", 620, 466, 500),
        panelLabel("subscribe note", 1084, 386, 418)
      ]
    },
    {
      slug: "speaker-summit-invite",
      title: "Website-Like Speaker Summit Invite",
      transcriptText: spokenTranscript(
        "This should be an invite page for a design and strategy summit.",
        "Give me one big summit title in the hero, a strong graphic or image area, a details and schedule section, a speakers strip, and a small RSVP note.",
        "I want it energetic and polished, more like an event identity than an editorial article."
      ),
      canvasWidth: 1280,
      canvasHeight: 720,
      shapes: [
        roughBlob(300, 38, 724, 224),
        roughStrip(442, 212, 392, 82),
        roughPanel(144, 318, 462, 210, { bow: -2 }),
        { type: "line", x1: 666, y1: 424, x2: 1068, y2: 424 },
        roughStrip(968, 454, 156, 108)
      ],
      labels: [
        panelLabel("summit title", 632, 4, 38),
        panelLabel("hero graphic", 660, 282, 160),
        panelLabel("details / schedule", 388, 548, 422),
        panelLabel("speakers", 866, 392, 424),
        panelLabel("rsvp note", 1046, 420, 454)
      ]
    },
    {
      slug: "meal-membership-pricing",
      title: "Website-Like Meal Membership Pricing",
      transcriptText: spokenTranscript(
        "I want this to be a pricing page for a meal membership.",
        "At the top put the title and a small hero image or dish area, then I want a comparison block for the plans, a benefits strip, and a signup note.",
        "Keep it commercial and clear, but don't make it a wall of identical pricing cards."
      ),
      canvasWidth: 1280,
      canvasHeight: 720,
      shapes: [
        roughStrip(158, 56, 382, 84),
        roughBlob(746, 74, 282, 196),
        roughPanel(162, 304, 674, 224, { bow: 2 }),
        { type: "line", x1: 170, y1: 572, x2: 846, y2: 572 },
        roughStrip(918, 404, 176, 158)
      ],
      labels: [
        panelLabel("pricing title", 348, 22, 56),
        panelLabel("dish image", 882, 292, 170),
        panelLabel("plan comparison", 520, 548, 418),
        panelLabel("benefits", 504, 538, 572),
        panelLabel("signup note", 1000, 370, 404)
      ]
    },
    {
      slug: "urban-planning-research-home",
      title: "Website-Like Urban Planning Research Home",
      transcriptText: spokenTranscript(
        "I want this one to be a homepage for an urban planning researcher.",
        "Put the researcher name and title prominently at the top, then I want a short abstract or statement, a publications area, a projects strip, and a tiny contact or lectures note.",
        "Keep it intelligent and sharp, not dusty, and not too text heavy."
      ),
      canvasWidth: 1280,
      canvasHeight: 720,
      shapes: [
        roughStrip(142, 54, 462, 88),
        { type: "line", x1: 146, y1: 232, x2: 1042, y2: 232 },
        roughPanel(148, 266, 404, 216, { bow: -2 }),
        roughStrip(620, 274, 412, 70),
        { type: "line", x1: 158, y1: 538, x2: 1032, y2: 538 },
        roughStrip(954, 440, 150, 98)
      ],
      labels: [
        panelLabel("researcher name", 370, 18, 54),
        panelLabel("abstract", 370, 198, 232),
        panelLabel("publications", 350, 506, 376),
        panelLabel("projects", 824, 240, 274),
        panelLabel("lectures / contact", 1026, 406, 440)
      ]
    }
  ];
}

const SPECS_BY_ROUND: Record<RoundKey, BenchmarkSpec[]> = {
  a: buildRoundASpecs(),
  b: buildRoundBSpecs(),
  c: buildRoundCSpecs(),
  d: buildRoundDSpecs(),
  e: buildRoundESpecs()
};

function tokenizeTranscript(transcriptText: string) {
  return transcriptText
    .trim()
    .split(/\s+/)
    .map((text, index) => ({
      id: `token-${index + 1}`,
      text,
      startMs: index * 260,
      endMs: index * 260 + 220,
      granularity: "word",
      lang: "en",
      approximate: false
    }));
}

function renderShape(shape: Shape) {
  switch (shape.type) {
    case "path":
      return `<path d="${shape.d}" fill="none" stroke="#18191c" stroke-width="7" stroke-linecap="round" stroke-linejoin="round" />`;
    case "line":
      return `<line x1="${shape.x1}" y1="${shape.y1}" x2="${shape.x2}" y2="${shape.y2}" stroke="#18191c" stroke-width="7" stroke-linecap="round" />`;
    case "circle":
      return `<circle cx="${shape.cx}" cy="${shape.cy}" r="${shape.r}" fill="none" stroke="#18191c" stroke-width="7" />`;
  }
}

function renderSvg(spec: BenchmarkSpec, annotated: boolean) {
  const labelLayer = annotated
    ? spec.labels
        .map((label) => {
          const width = Math.max(126, label.text.length * 9 + 34);
          const x = label.x - width / 2;
          const y = label.y;
          const stemToY = label.stemToY ?? y + 56;
          return [
            `<rect x="${x}" y="${y}" width="${width}" height="38" rx="19" fill="#f7fff8" stroke="#5f8f86" stroke-width="3" />`,
            `<text x="${label.x}" y="${y + 25}" text-anchor="middle" font-family="ui-sans-serif, system-ui" font-size="15" font-weight="600" fill="#324f49">${label.text}</text>`,
            `<line x1="${label.x}" y1="${y + 38}" x2="${label.x}" y2="${stemToY}" stroke="#5f8f86" stroke-width="3" stroke-linecap="round" />`,
            `<circle cx="${label.x}" cy="${stemToY}" r="5" fill="#5f8f86" />`
          ].join("");
        })
        .join("")
    : "";

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${spec.canvasWidth}" height="${spec.canvasHeight}" viewBox="0 0 ${spec.canvasWidth} ${spec.canvasHeight}">
  <rect width="${spec.canvasWidth}" height="${spec.canvasHeight}" fill="#f9f2df" />
  ${spec.shapes.map(renderShape).join("")}
  ${labelLayer}
</svg>`;
}

async function writePng(filePath: string, svg: string) {
  const sharp = (await import("sharp")).default;
  await writeFile(filePath, await sharp(Buffer.from(svg)).png().toBuffer());
}

async function writeContactSheet(roundId: string, items: Array<{ title: string; imagePath: string }>) {
  const sharp = (await import("sharp")).default;
  const columns = 2;
  const tileWidth = 640;
  const tileHeight = 360;
  const captionHeight = 44;
  const gutter = 18;
  const rows = Math.ceil(items.length / columns);
  const width = columns * tileWidth + (columns + 1) * gutter;
  const height = rows * (tileHeight + captionHeight) + (rows + 1) * gutter;
  const composites: Array<Parameters<typeof sharp>[0] extends never ? never : any> = [];

  for (const [index, item] of items.entries()) {
    const row = Math.floor(index / columns);
    const column = index % columns;
    const left = gutter + column * (tileWidth + gutter);
    const top = gutter + row * (tileHeight + captionHeight + gutter);
    const image = await sharp(item.imagePath).resize(tileWidth, tileHeight, { fit: "contain", background: "#f9f2df" }).png().toBuffer();
    const captionSvg = Buffer.from(`
      <svg xmlns="http://www.w3.org/2000/svg" width="${tileWidth}" height="${captionHeight}">
        <rect width="${tileWidth}" height="${captionHeight}" fill="#fffaf0"/>
        <text x="18" y="28" font-family="ui-sans-serif, system-ui" font-size="18" font-weight="700" fill="#2c2c2c">${item.title}</text>
      </svg>
    `);
    composites.push({ input: image, left, top });
    composites.push({ input: captionSvg, left, top: top + tileHeight });
  }

  const outputPath = path.join(BENCHMARK_ROOT, `${roundId}-sketch-contact-sheet.png`);
  await sharp({
    create: {
      width,
      height,
      channels: 4,
      background: "#efe4c7"
    }
  })
    .composite(composites)
    .png()
    .toFile(outputPath);

  return outputPath;
}

function parseRoundFromArgs(): RoundKey {
  const flagIndex = process.argv.findIndex((value) => value === "--round");
  const rawValue = flagIndex >= 0 ? process.argv[flagIndex + 1] : "a";

  if (rawValue === "a" || rawValue === "b" || rawValue === "c" || rawValue === "d" || rawValue === "e") {
    return rawValue;
  }

  throw new Error("Usage: npx tsx scripts/create-website-like-benchmarks.ts --round <a|b|c|d|e>");
}

async function main() {
  const roundKey = parseRoundFromArgs();
  const specs = SPECS_BY_ROUND[roundKey];
  const roundId = `website-like-round-${roundKey}-${new Date().toISOString().slice(0, 10)}`;
  const tasks = [];
  const sheetItems: Array<{ title: string; imagePath: string }> = [];

  await mkdir(BENCHMARK_ROOT, { recursive: true });

  for (const spec of specs) {
    const sessionId = randomUUID();
    const sessionDir = path.join(SESSION_ROOT, sessionId);
    await rm(sessionDir, { recursive: true, force: true });
    await mkdir(sessionDir, { recursive: true });

    const createdAt = new Date().toISOString();
    const meta = {
      id: sessionId,
      title: spec.title,
      status: "ready",
      createdAt,
      updatedAt: createdAt,
      durationMs: 2000,
      audioMimeType: null,
      canvasWidth: spec.canvasWidth,
      canvasHeight: spec.canvasHeight,
      transcriptApproximate: false,
      analysisReasoningEffort: "medium",
      imageSizePreset: "medium",
      imageGenerationProfile: "pro",
      errorMessage: null
    };
    const analysis = {
      model: "website-like-benchmark",
      createdAt,
      transcriptText: spec.transcriptText,
      objects: [],
      globalInfo: {
        background: "",
        style: "Website-like wireframe sketch",
        relationships: "",
        story: "",
        extra: ""
      },
      generationPrompt: "",
      notes: ["Synthetic website-like benchmark fixture derived from Derek-style low-fidelity wireframes"]
    };

    const sketchPath = path.join(sessionDir, "sketch.png");
    const annotatedSketchPath = path.join(sessionDir, "annotated-sketch.png");

    await writeFile(path.join(sessionDir, "meta.json"), JSON.stringify(meta, null, 2));
    await writeFile(path.join(sessionDir, "events.json"), JSON.stringify([], null, 2));
    await writeFile(path.join(sessionDir, "transcript.json"), JSON.stringify(tokenizeTranscript(spec.transcriptText), null, 2));
    await writeFile(path.join(sessionDir, "analysis.json"), JSON.stringify(analysis, null, 2));
    await writePng(sketchPath, renderSvg(spec, false));
    await writePng(annotatedSketchPath, renderSvg(spec, true));

    sheetItems.push({ title: spec.title, imagePath: annotatedSketchPath });
    tasks.push({
      sessionId,
      slug: spec.slug,
      title: spec.title,
      transcriptText: spec.transcriptText
    });
  }

  const manifestPath = path.join(BENCHMARK_ROOT, `${roundId}.json`);
  const contactSheetPath = await writeContactSheet(roundId, sheetItems);
  await writeFile(
    manifestPath,
    JSON.stringify(
      {
        roundId,
        kind: "website-like",
        sourceStyle: "derek-like-lowfi-wireframe",
        contactSheetPath,
        tasks
      },
      null,
      2
    )
  );
  process.stdout.write(`${manifestPath}\n`);
  process.stdout.write(`${contactSheetPath}\n`);
}

void main();

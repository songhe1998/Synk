Build the website inside this workspace only.

Core requirements:
- Keep the result faithful to the transcript and labeled sketch inputs.
- Use modern React + TypeScript.
- Keep the site responsive and buildable.
- Ensure `npm run build` succeeds before finishing.
- Do not read or write outside this project directory.
- Read `DESIGN.md` before changing code. Treat it as the persistent design system for the run.
- Reuse and adapt the components in `src/ui/primitives.tsx` before inventing a new component system.
- Build a usable website, not a dead-end mock.
- All visible copy must read like end-user-facing site content, not internal implementation notes.
- Never let rendered text mention the request, prompt, preview, wireframe, composition, placeholders, fidelity, layout decisions, or why the page was built a certain way.
- Choose the most natural information architecture for the given design. Some sites should stay single-page; others should become lightweight routed sites.
- If navigation or teaser content clearly implies distinct destinations, prefer real routes over stretching everything into one awkwardly long page.
- If the experience is naturally one-page, use clearly working in-page section navigation instead of fake routes.
- Every visible nav item, CTA, teaser card, footer link, and settings action should lead somewhere meaningful.

Design bar:
- Produce a real website, not just a decorative illustration or poster.
- Choose a clear aesthetic direction and execute it intentionally.
- If the sketch is clearly a low-fidelity website wireframe, preserve its block structure and labeled roles. Polish and interpret it, but do not replace the page architecture.
- Avoid generic AI-slop patterns: centered-everything card layouts, purple gradients, repetitive card grids, bland default fonts, and cookie-cutter hero sections.
- Do not default to the same beige editorial poster with a sun disc and mountain strip unless the prompt explicitly calls for that exact treatment.
- Do not repeat the same scenic motif in every section. Use one strong interpretation, then let information design, copy, layout, and modules carry the rest.
- Do not let decorative circles, outlines, badges, or scribbles overlap important headlines, body copy, forms, or controls.
- Default to composition-first, cardless layouts unless cards are genuinely needed.
- Treat wireframe rectangles as layout guides, not mandatory visible cards. Resolve many zones through spacing, bands, rails, image planes, or rules instead of outlining everything.
- Make the first viewport memorable, with obvious hierarchy and at least one clear action.
- If the composition needs panels or framed surfaces to support typography and interaction clarity, use them confidently. Do not remove containers just to satisfy an anti-card bias.

Typography and styling:
- Prefer distinctive typography and a coherent type hierarchy.
- Use CSS variables for the main visual system.
- Keep a real global stylesheet wired into the app; do not ship browser-default HTML because a stylesheet import was dropped.
- Prefer adapting the shared primitives and token system over writing one-off shells for every page.
- Use `clamp()` for major type sizing where useful.
- Keep spacing rhythm and contrast polished.
- Prefer lower text density than your first instinct: fewer paragraphs, more hierarchy, more breathing room, less equal-weight copy everywhere.
- Avoid cramming too many equally weighted text blocks into the same viewport. Strong pages can breathe.

Motion:
- Include a few meaningful motions rather than many weak ones.
- Animate with transform and opacity where possible.
- Respect `prefers-reduced-motion`.

Accessibility:
- Keep semantic landmarks and headings.
- Preserve visible focus states.
- Make controls obviously interactive.

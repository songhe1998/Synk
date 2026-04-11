"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { SessionDetail } from "@/lib/types";

function getPrimaryImage(session: SessionDetail) {
  if (session.generatedImageLabeledUrl) {
    return {
      url: session.generatedImageLabeledUrl,
      label: "Generated image"
    };
  }

  if (session.generatedImagePlainUrl) {
    return {
      url: session.generatedImagePlainUrl,
      label: "Generated image"
    };
  }

  return {
    url: session.annotatedSketchUrl ?? session.sketchUrl,
    label: session.annotatedSketchUrl ? "Annotated sketch" : "Sketch"
  };
}

export function ImageExperienceShell({ session }: { session: SessionDetail }) {
  const [infoOpen, setInfoOpen] = useState(false);
  const primaryImage = useMemo(() => getPrimaryImage(session), [session]);

  return (
    <main className="image-experience-page">
      <section className="image-experience-stage">
        {primaryImage.url ? (
          <>
            <img src={primaryImage.url} alt={primaryImage.label} className="image-experience-background" />
            <img src={primaryImage.url} alt={primaryImage.label} className="image-experience-image" />
          </>
        ) : (
          <div className="image-experience-empty">No generated image is available for this session yet.</div>
        )}

        <div className="image-experience-vignette" />

        <header className="image-experience-header">
          <Link href="/" className="image-hud-button image-hud-button-strong">
            Back home
          </Link>

          <div className="image-header-actions">
            <button type="button" className="image-hud-button" onClick={() => setInfoOpen((value) => !value)}>
              {infoOpen ? "Close info" : "Info"}
            </button>
          </div>
        </header>

        {infoOpen ? (
          <button
            type="button"
            className="image-info-scrim"
            onClick={() => setInfoOpen(false)}
            aria-label="Close image details"
          />
        ) : null}

        <aside className={`image-info-drawer ${infoOpen ? "open" : ""}`}>
          <div className="image-info-header">
            <div>
              <p className="image-info-kicker">Image details</p>
              <h2>{session.title}</h2>
            </div>
            <button type="button" className="image-hud-button" onClick={() => setInfoOpen(false)}>
              Close
            </button>
          </div>

          <div className="image-info-body">
            {session.analysis?.generationPrompt ? (
              <section className="image-info-section">
                <p className="image-info-label">Final prompt</p>
                <p className="image-info-copy">{session.analysis.generationPrompt}</p>
              </section>
            ) : null}

            {session.annotatedSketchUrl ? (
              <section className="image-info-section">
                <p className="image-info-label">Labeled sketch</p>
                <img src={session.annotatedSketchUrl} alt="Labeled sketch" className="image-info-image" />
              </section>
            ) : null}
          </div>
        </aside>
      </section>
    </main>
  );
}

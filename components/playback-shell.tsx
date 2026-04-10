"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { applyDrawingEvent, createEmptyDrawingState, drawDrawingState, formatDuration } from "@/lib/drawing";
import {
  AnalysisReasoningEffort,
  DrawingState,
  GroundedSceneObject,
  ImageGenerationSource,
  ImageSizePreset,
  SessionDetail,
  TranscriptToken
} from "@/lib/types";

type AssetView = "sketch" | "annotatedSketch" | "generatedLabeled" | "generatedPlain";
const REASONING_EFFORTS: AnalysisReasoningEffort[] = ["low", "medium", "high"];
const IMAGE_SIZE_PRESETS: ImageSizePreset[] = ["small", "medium", "large"];

function getActiveTokenIndex(tokens: TranscriptToken[], currentTimeMs: number) {
  return tokens.findIndex((token, index) => {
    const isLastToken = index === tokens.length - 1;
    const tokenStartsNow = currentTimeMs >= token.startMs;
    const tokenStillActive = isLastToken ? currentTimeMs <= token.endMs : currentTimeMs < token.endMs;
    return tokenStartsNow && tokenStillActive;
  });
}

function formatCreatedAt(isoString: string) {
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(new Date(isoString));
}

function isAssetViewAvailable(session: SessionDetail, view: AssetView) {
  switch (view) {
    case "sketch":
      return Boolean(session.sketchUrl);
    case "annotatedSketch":
      return Boolean(session.annotatedSketchUrl);
    case "generatedLabeled":
      return Boolean(session.generatedImageLabeledUrl);
    case "generatedPlain":
      return Boolean(session.generatedImagePlainUrl);
  }
}

function getDefaultAssetView(session: SessionDetail) {
  const priority: AssetView[] = [
    "generatedLabeled",
    "generatedPlain",
    "annotatedSketch",
    "sketch"
  ];
  return priority.find((view) => isAssetViewAvailable(session, view)) ?? "sketch";
}

function resolveAssetView(session: SessionDetail, preferred: AssetView | null) {
  if (preferred && isAssetViewAvailable(session, preferred)) {
    return preferred;
  }
  return getDefaultAssetView(session);
}

export function PlaybackShell({ session }: { session: SessionDetail }) {
  const [sessionData, setSessionData] = useState(session);
  const [selectedAssetView, setSelectedAssetView] = useState<AssetView>(() => getDefaultAssetView(session));
  const [reasoningEffort, setReasoningEffort] = useState<AnalysisReasoningEffort>(session.analysisReasoningEffort);
  const [imageSizePreset, setImageSizePreset] = useState<ImageSizePreset>(session.imageSizePreset);
  const [analysisExpanded, setAnalysisExpanded] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const replayStateRef = useRef<DrawingState>(createEmptyDrawingState());
  const replayCursorRef = useRef(0);
  const lastDrawTimeRef = useRef(0);
  const animationFrameRef = useRef<number | null>(null);
  const manualSeekInFlightRef = useRef(false);
  const manualSeekTimeoutRef = useRef<number | null>(null);
  const manualSeekTargetRef = useRef<number | null>(null);

  const [currentTimeMs, setCurrentTimeMs] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [analysisBusy, setAnalysisBusy] = useState(false);
  const [generationSourceBusy, setGenerationSourceBusy] = useState<ImageGenerationSource | null>(null);
  const [pipelineError, setPipelineError] = useState<string | null>(null);
  const autoAnalyzeAttemptRef = useRef<string | null>(null);
  const autoGenerateLabeledAttemptRef = useRef<string | null>(null);

  function cancelPlaybackLoop() {
    if (animationFrameRef.current) {
      window.cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
  }

  function clearManualSeekTimeout() {
    if (manualSeekTimeoutRef.current) {
      window.clearTimeout(manualSeekTimeoutRef.current);
      manualSeekTimeoutRef.current = null;
    }
  }

  function finalizeManualSeek(resolvedTimeMs: number) {
    clearManualSeekTimeout();
    manualSeekInFlightRef.current = false;
    manualSeekTargetRef.current = null;
    setCurrentTimeMs(Math.max(0, Math.min(resolvedTimeMs, sessionData.durationMs)));
  }

  function syncTimeFromAudio(audio: HTMLAudioElement) {
    if (manualSeekInFlightRef.current) {
      return;
    }

    setCurrentTimeMs(Math.round(audio.currentTime * 1000));
  }

  function syncPlaybackPosition(nextTimeMs: number, options?: { pause?: boolean }) {
    const clampedTimeMs = Math.max(0, Math.min(nextTimeMs, sessionData.durationMs));
    const audio = audioRef.current;
    manualSeekInFlightRef.current = true;
    manualSeekTargetRef.current = clampedTimeMs;
    clearManualSeekTimeout();

    if (audio) {
      if (options?.pause) {
        cancelPlaybackLoop();
        setIsPlaying(false);
        audio.pause();
      }
      audio.currentTime = clampedTimeMs / 1000;
    }

    setCurrentTimeMs(clampedTimeMs);
    manualSeekTimeoutRef.current = window.setTimeout(() => {
      const resolvedTimeMs = audio ? Math.round(audio.currentTime * 1000) : clampedTimeMs;
      finalizeManualSeek(resolvedTimeMs);
    }, 180);
  }

  function redraw(timeMs: number) {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

    if (timeMs < lastDrawTimeRef.current) {
      replayStateRef.current = createEmptyDrawingState();
      replayCursorRef.current = 0;
    }

    while (
      replayCursorRef.current < sessionData.events.length &&
      sessionData.events[replayCursorRef.current].tMs <= timeMs
    ) {
      applyDrawingEvent(replayStateRef.current, sessionData.events[replayCursorRef.current]);
      replayCursorRef.current += 1;
    }

    const context = canvas.getContext("2d");
    if (!context) {
      return;
    }
    drawDrawingState(context, replayStateRef.current, sessionData.canvasWidth, sessionData.canvasHeight);
    lastDrawTimeRef.current = timeMs;
  }

  useEffect(() => {
    redraw(0);
  }, []);

  useEffect(() => {
    redraw(currentTimeMs);
  }, [currentTimeMs]);

  useEffect(() => {
    return () => {
      cancelPlaybackLoop();
      clearManualSeekTimeout();
    };
  }, []);

  useEffect(() => {
    if (!isPlaying) {
      cancelPlaybackLoop();
      return;
    }

    const tick = () => {
      const audio = audioRef.current;
      if (!audio) {
        return;
      }
      syncTimeFromAudio(audio);
      animationFrameRef.current = window.requestAnimationFrame(tick);
    };

    animationFrameRef.current = window.requestAnimationFrame(tick);

    return () => {
      cancelPlaybackLoop();
    };
  }, [isPlaying]);

  const activeTokenIndex = getActiveTokenIndex(sessionData.transcript, currentTimeMs);

  function seekToToken(token: TranscriptToken) {
    syncPlaybackPosition(token.startMs, { pause: true });
  }

  function handleTimelineChange(value: string) {
    const nextValue = Number.parseInt(value, 10);
    syncPlaybackPosition(nextValue, { pause: true });
  }

  async function refreshSession() {
    const response = await fetch(`/api/sessions/${sessionData.id}`, { cache: "no-store" });
    if (!response.ok) {
      throw new Error("Failed to refresh session data.");
    }
    const payload = (await response.json()) as SessionDetail;
    setSessionData(payload);
    setReasoningEffort(payload.analysisReasoningEffort);
    setImageSizePreset(payload.imageSizePreset);
    setSelectedAssetView((current) => resolveAssetView(payload, current));
    return payload;
  }

  async function runAnalysis(options?: { background?: boolean }) {
    if (!options?.background) {
      setPipelineError(null);
    }
    setAnalysisBusy(true);

    try {
      const response = await fetch(`/api/sessions/${sessionData.id}/analyze`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          reasoningEffort
        })
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload.error || "Analysis failed.");
      }
      const nextSession = payload as SessionDetail;
      setSessionData(nextSession);
      setReasoningEffort(nextSession.analysisReasoningEffort);
      setImageSizePreset(nextSession.imageSizePreset);
      setSelectedAssetView(resolveAssetView(nextSession, "annotatedSketch"));
    } catch (error) {
      if (!options?.background) {
        setPipelineError(error instanceof Error ? error.message : "Analysis failed.");
      }
    } finally {
      setAnalysisBusy(false);
    }
  }

  async function runImageGeneration(source: ImageGenerationSource, options?: { background?: boolean }) {
    if (!options?.background) {
      setPipelineError(null);
    }
    setGenerationSourceBusy(source);

    try {
      const response = await fetch(`/api/sessions/${sessionData.id}/generate-image`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          source,
          imageSizePreset
        })
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload.error || "Image generation failed.");
      }
      const nextSession = payload as SessionDetail;
      setSessionData(nextSession);
      setReasoningEffort(nextSession.analysisReasoningEffort);
      setImageSizePreset(nextSession.imageSizePreset);
      setSelectedAssetView(resolveAssetView(nextSession, source === "labeled" ? "generatedLabeled" : "generatedPlain"));
    } catch (error) {
      if (!options?.background) {
        setPipelineError(error instanceof Error ? error.message : "Image generation failed.");
      }
    } finally {
      setGenerationSourceBusy(null);
    }
  }

  const currentAsset = (() => {
    switch (selectedAssetView) {
      case "generatedLabeled":
        return {
          title: "Generated from labeled sketch",
          url: sessionData.generatedImageLabeledUrl,
          alt: "Generated scene using labeled sketch"
        };
      case "generatedPlain":
        return {
          title: "Generated from plain sketch",
          url: sessionData.generatedImagePlainUrl,
          alt: "Generated scene using plain sketch"
        };
      case "annotatedSketch":
        return {
          title: "Annotated sketch",
          url: sessionData.annotatedSketchUrl,
          alt: "Annotated sketch"
        };
      case "sketch":
      default:
        return {
          title: "Plain sketch",
          url: sessionData.sketchUrl,
          alt: "Original sketch"
        };
    }
  })();

  useEffect(() => {
    const nextAutoAnalyzeKey = `${sessionData.id}:${reasoningEffort}`;
    const shouldAutoAnalyze =
      sessionData.transcript.length > 0 &&
      !sessionData.analysis &&
      !analysisBusy &&
      generationSourceBusy === null &&
      autoAnalyzeAttemptRef.current !== nextAutoAnalyzeKey;

    if (!shouldAutoAnalyze) {
      return;
    }

    autoAnalyzeAttemptRef.current = nextAutoAnalyzeKey;
    void runAnalysis({ background: true });
  }, [
    analysisBusy,
    generationSourceBusy,
    reasoningEffort,
    sessionData.analysis,
    sessionData.id,
    sessionData.transcript.length
  ]);

  useEffect(() => {
    const analysisCreatedAt = sessionData.analysis?.createdAt;
    if (!analysisCreatedAt) {
      return;
    }

    const nextAutoGenerateKey = `${sessionData.id}:${analysisCreatedAt}:${imageSizePreset}:labeled`;
    const shouldAutoGenerateLabeled =
      !analysisBusy &&
      generationSourceBusy === null &&
      !sessionData.generatedImageLabeledUrl &&
      autoGenerateLabeledAttemptRef.current !== nextAutoGenerateKey;

    if (!shouldAutoGenerateLabeled) {
      return;
    }

    autoGenerateLabeledAttemptRef.current = nextAutoGenerateKey;
    void runImageGeneration("labeled", { background: true });
  }, [
    analysisBusy,
    generationSourceBusy,
    imageSizePreset,
    sessionData.analysis?.createdAt,
    sessionData.generatedImageLabeledUrl,
    sessionData.id
  ]);

  function renderObjectCard(object: GroundedSceneObject) {
    return (
      <article key={object.id} className="analysis-card">
        <div className="analysis-card-header">
          <div>
            <p className="analysis-title">{object.tag}</p>
            <p className="analysis-subtitle">{object.label}</p>
          </div>
          <span className="status-chip">{object.clusterIds.join(", ") || "ungrounded"}</span>
        </div>
        <p className="analysis-copy">{object.description || "No extra description captured."}</p>
        <div className="analysis-section">
          <strong>Evidence</strong>
          <div className="evidence-list">
            {object.evidenceMatches.length === 0 ? (
              <span className="empty-copy">No transcript evidence matched.</span>
            ) : (
              object.evidenceMatches.map((match, index) => (
                <div key={`${object.id}-${index}`} className="evidence-chip">
                  <span>{match.matchedText || match.quote}</span>
                  <small>
                    {match.startMs !== null ? formatDuration(match.startMs) : "unmatched"} · {match.matchKind}
                  </small>
                </div>
              ))
            )}
          </div>
        </div>
      </article>
    );
  }

  return (
    <main className="page-shell">
      <section className="hero-card playback-hero">
        <div className="hero-copy">
          <p className="eyebrow">Replay</p>
          <h1>{sessionData.title}</h1>
          <p className="hero-text">
            Drag the timeline, tap any token, or play through the entire session with synchronized strokes
            and speech.
          </p>
        </div>

        <div className="hero-actions">
          <Link href="/" className="ghost-link">
            Back to recorder
          </Link>
          <div className="meta-stack">
            <span>{formatCreatedAt(sessionData.createdAt)}</span>
            <span>{formatDuration(sessionData.durationMs)}</span>
            <span>{sessionData.status}</span>
          </div>
        </div>
      </section>

      <section className="workspace-grid playback-grid">
        <div className="panel canvas-panel">
          <div className="panel-header">
            <div>
              <p className="panel-kicker">Canvas replay</p>
              <h2>Board state at {formatDuration(currentTimeMs)}</h2>
            </div>
            {sessionData.transcriptApproximate ? (
              <div className="status-chip warning-chip">Chinese char timing is approximated for this demo.</div>
            ) : (
              <div className="status-chip">Token timings from transcription API</div>
            )}
          </div>

          <div className="canvas-frame">
            <canvas
              ref={canvasRef}
              width={sessionData.canvasWidth}
              height={sessionData.canvasHeight}
              className="recording-canvas"
            />
          </div>

          <div className="audio-panel">
            {sessionData.audioUrl ? (
              <audio
                ref={audioRef}
                src={sessionData.audioUrl}
                controls
                className="audio-player"
                onPlay={() => {
                  clearManualSeekTimeout();
                  manualSeekInFlightRef.current = false;
                  manualSeekTargetRef.current = null;
                  setIsPlaying(true);
                }}
                onPause={(event) => {
                  cancelPlaybackLoop();
                  setIsPlaying(false);
                  syncTimeFromAudio(event.currentTarget);
                }}
                onEnded={() => {
                  cancelPlaybackLoop();
                  clearManualSeekTimeout();
                  manualSeekInFlightRef.current = false;
                  manualSeekTargetRef.current = null;
                  setIsPlaying(false);
                  setCurrentTimeMs(sessionData.durationMs);
                }}
                onSeeked={(event) => {
                  finalizeManualSeek(Math.round(event.currentTarget.currentTime * 1000));
                }}
                onTimeUpdate={(event) => syncTimeFromAudio(event.currentTarget)}
              />
            ) : (
              <p className="empty-copy">No audio file found for this session.</p>
            )}

            <input
              type="range"
              min={0}
              max={Math.max(sessionData.durationMs, 1)}
              value={Math.min(currentTimeMs, sessionData.durationMs)}
              onChange={(event) => handleTimelineChange(event.target.value)}
            />

            <div className="timeline-row">
              <span>0:00</span>
              <span>{formatDuration(currentTimeMs)}</span>
              <span>{formatDuration(sessionData.durationMs)}</span>
            </div>
          </div>
        </div>

        <aside className="panel transcript-panel">
          <div className="panel-header">
            <div>
              <p className="panel-kicker">Transcript</p>
              <h2>Click any token to jump</h2>
            </div>
            <div className="status-chip">{sessionData.transcript.length} tokens</div>
          </div>

          {sessionData.transcript.length === 0 ? (
            <p className="empty-copy">No transcript available for this session yet.</p>
          ) : (
            <div className="token-grid">
              {sessionData.transcript.map((token, index) => (
                <button
                  key={token.id}
                  type="button"
                  className={`token-pill ${index === activeTokenIndex ? "active" : ""} ${
                    token.approximate ? "approximate" : ""
                  }`}
                  onClick={() => seekToToken(token)}
                >
                  <span>{token.text}</span>
                  <small>{formatDuration(token.startMs)}</small>
                </button>
              ))}
            </div>
          )}
        </aside>
      </section>

      <section className="analysis-grid">
        <div className="panel analysis-panel">
          <div className="panel-header">
            <div>
              <p className="panel-kicker">Understanding</p>
              <h2>Transcript to grounded objects</h2>
            </div>
            <div className="analysis-actions">
              <button type="button" className="ghost-button" onClick={refreshSession}>
                Refresh
              </button>
              <button
                type="button"
                className="ghost-button"
                onClick={() => setAnalysisExpanded((value) => !value)}
              >
                {analysisExpanded ? "Hide analysis" : "Show analysis"}
              </button>
              <button
                type="button"
                className="primary-button"
                onClick={() => runAnalysis()}
                disabled={analysisBusy || generationSourceBusy !== null}
              >
                {analysisBusy ? "Analyzing..." : "Analyze with GPT-5.4"}
              </button>
              <button
                type="button"
                className="ghost-button"
                onClick={() => runImageGeneration("plain")}
                disabled={!sessionData.analysis || analysisBusy || generationSourceBusy !== null}
              >
                {generationSourceBusy === "plain" ? "Generating plain..." : "Generate from plain sketch"}
              </button>
            </div>
          </div>

          {pipelineError ? <p className="error-banner">{pipelineError}</p> : null}

          <div className="analysis-options-grid">
            <div className="analysis-option-group">
              <span className="analysis-option-label">Reasoning effort</span>
              <div className="segmented-control">
                {REASONING_EFFORTS.map((effort) => (
                  <button
                    key={effort}
                    type="button"
                    className={reasoningEffort === effort ? "active" : ""}
                    onClick={() => setReasoningEffort(effort)}
                    disabled={analysisBusy || generationSourceBusy !== null}
                  >
                    {effort}
                  </button>
                ))}
              </div>
            </div>

            <div className="analysis-option-group">
              <span className="analysis-option-label">Image size</span>
              <div className="segmented-control">
                {IMAGE_SIZE_PRESETS.map((preset) => (
                  <button
                    key={preset}
                    type="button"
                    className={imageSizePreset === preset ? "active" : ""}
                    onClick={() => setImageSizePreset(preset)}
                    disabled={analysisBusy || generationSourceBusy !== null}
                  >
                    {preset}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {!analysisExpanded ? (
            <div className="analysis-collapsed-card">
              <p className="analysis-copy">
                {analysisBusy
                  ? `Analysis is running in the background with ${reasoningEffort} reasoning.`
                  : generationSourceBusy === "labeled"
                    ? `Analysis is ready and the labeled result is generating automatically at ${imageSizePreset} size.`
                  : sessionData.analysis
                    ? sessionData.generatedImageLabeledUrl
                      ? "Analysis is ready and the labeled result has already been generated. Expand this panel to inspect objects, evidence, and the generation prompt."
                      : "Analysis is ready. The labeled result will generate automatically; expand this panel to inspect objects, evidence, and the generation prompt."
                    : "Analysis will run automatically after transcription, then the labeled result will generate automatically."}
              </p>
            </div>
          ) : sessionData.analysis ? (
            <div className="analysis-layout">
              <div className="analysis-column">
                <div className="analysis-summary-card">
                  <p className="analysis-title">Model</p>
                  <p className="analysis-copy">{sessionData.analysis.model}</p>
                  <p className="analysis-title">Transcript</p>
                  <p className="analysis-copy">{sessionData.analysis.transcriptText}</p>
                </div>

                <div className="analysis-summary-card">
                  <p className="analysis-title">Global scene</p>
                  <p className="analysis-copy">
                    <strong>Background:</strong> {sessionData.analysis.globalInfo.background || "None"}
                  </p>
                  <p className="analysis-copy">
                    <strong>Style:</strong> {sessionData.analysis.globalInfo.style || "None"}
                  </p>
                  <p className="analysis-copy">
                    <strong>Relationships:</strong> {sessionData.analysis.globalInfo.relationships || "None"}
                  </p>
                  <p className="analysis-copy">
                    <strong>Story/Mood:</strong> {sessionData.analysis.globalInfo.story || "None"}
                  </p>
                  <p className="analysis-copy">
                    <strong>Extra:</strong> {sessionData.analysis.globalInfo.extra || "None"}
                  </p>
                </div>

                <div className="analysis-summary-card">
                  <p className="analysis-title">Generation prompt</p>
                  <p className="analysis-copy">{sessionData.analysis.generationPrompt}</p>
                </div>
              </div>

              <div className="analysis-column">
                <div className="analysis-summary-card">
                  <p className="analysis-title">Objects</p>
                  <div className="analysis-card-list">
                    {sessionData.analysis.objects.length === 0 ? (
                      <p className="empty-copy">No objects extracted yet.</p>
                    ) : (
                      sessionData.analysis.objects.map((object) => renderObjectCard(object))
                    )}
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <p className="empty-copy">
              Run analysis to extract objects, evidence quotes, global scene info, and an image-generation prompt.
            </p>
          )}
        </div>

        <div className="panel image-panel">
          <div className="panel-header">
            <div>
              <p className="panel-kicker">Assets</p>
              <h2>Sketch labels and generated image</h2>
            </div>
          </div>

          <div className="asset-switcher">
            <div className="segmented-control asset-tabs">
              <button
                type="button"
                className={selectedAssetView === "sketch" ? "active" : ""}
                onClick={() => setSelectedAssetView("sketch")}
                disabled={!sessionData.sketchUrl}
              >
                Plain sketch
              </button>
              <button
                type="button"
                className={selectedAssetView === "annotatedSketch" ? "active" : ""}
                onClick={() => setSelectedAssetView("annotatedSketch")}
                disabled={!sessionData.annotatedSketchUrl}
              >
                Annotated sketch
              </button>
              <button
                type="button"
                className={selectedAssetView === "generatedLabeled" ? "active" : ""}
                onClick={() => setSelectedAssetView("generatedLabeled")}
                disabled={!sessionData.generatedImageLabeledUrl}
              >
                Labeled result
              </button>
              <button
                type="button"
                className={selectedAssetView === "generatedPlain" ? "active" : ""}
                onClick={() => setSelectedAssetView("generatedPlain")}
                disabled={!sessionData.generatedImagePlainUrl}
              >
                Plain result
              </button>
            </div>

            <div className="asset-card asset-preview-card">
              <p className="analysis-title">{currentAsset.title}</p>
              {currentAsset.url ? (
                <img src={currentAsset.url} alt={currentAsset.alt} className="asset-image" />
              ) : (
                <p className="empty-copy">This asset is not available yet.</p>
              )}
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}

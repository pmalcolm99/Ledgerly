"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { Button, Card, CardBody } from "@heroui/react";
import { Download, Share, X } from "lucide-react";

/**
 * apps/web/src/components/InstallPrompt.tsx — add-to-home-screen (task 7.9).
 *
 * Two entirely different platforms:
 *   Android/Chrome fires `beforeinstallprompt`, which can be deferred and
 *   replayed from a button.
 *   iOS Safari fires nothing and exposes no install API at all, so the only
 *   thing available is to tell the user where the button is. That is the
 *   platform this app is actually for, so the instruction is not a fallback —
 *   it is the main path.
 */

const DISMISSED_KEY = "ledgerly_install_dismissed";

type InstallEvent = Event & { prompt: () => Promise<void> };

function readDismissed(): boolean {
  try {
    return window.localStorage.getItem(DISMISSED_KEY) === "1";
  } catch {
    // Private mode or blocked site data. Treat as not dismissed — the prompt
    // is harmless, and this must never throw.
    return false;
  }
}

function isStandalone(): boolean {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    // Safari's own non-standard flag; the media query alone is false on iOS.
    (window.navigator as unknown as { standalone?: boolean }).standalone === true
  );
}

function isIos(): boolean {
  return (
    /iphone|ipad|ipod/i.test(window.navigator.userAgent) ||
    // iPadOS 13+ reports as a Mac; the touch-point check is what separates a
    // real Mac from an iPad.
    (window.navigator.platform === "MacIntel" && window.navigator.maxTouchPoints > 1)
  );
}

/**
 * These three facts are read from the browser, never change during a session,
 * and do not exist on the server.
 *
 * `useSyncExternalStore` with a `false` server snapshot is the right tool
 * rather than an effect that calls setState: it gives a stable, hydration-safe
 * value with no cascading render, which is exactly what
 * react-hooks/set-state-in-effect is pointing at. `subscribe` is a no-op
 * because nothing here can change without a reload.
 */
const NEVER_CHANGES = () => () => {};

function useClientFact(read: () => boolean): boolean {
  return useSyncExternalStore(NEVER_CHANGES, read, () => false);
}

export function InstallPrompt() {
  const [deferred, setDeferred] = useState<InstallEvent | null>(null);
  const [manuallyDismissed, setManuallyDismissed] = useState(false);

  const alreadyDismissed = useClientFact(readDismissed);
  const standalone = useClientFact(isStandalone);
  const ios = useClientFact(isIos);
  const suppressed = alreadyDismissed || standalone || manuallyDismissed;

  useEffect(() => {
    if (suppressed || ios) return;
    // Subscribing to an external event and setting state from its callback is
    // exactly what effects are for; the rule only objects to a synchronous
    // setState in the effect body.
    const onPrompt = (event: Event) => {
      event.preventDefault();
      setDeferred(event as InstallEvent);
    };
    window.addEventListener("beforeinstallprompt", onPrompt);
    return () => window.removeEventListener("beforeinstallprompt", onPrompt);
  }, [suppressed, ios]);

  function dismiss() {
    try {
      window.localStorage.setItem(DISMISSED_KEY, "1");
    } catch {
      /* storage blocked; the prompt simply returns next session */
    }
    setDeferred(null);
    setManuallyDismissed(true);
  }

  const showIosHint = ios && !suppressed;
  if (suppressed) return null;
  if (!deferred && !showIosHint) return null;

  return (
    <div
      className="fixed inset-x-0 bottom-0 z-[1100] mx-auto max-w-md p-3"
      style={{ paddingBottom: "calc(env(safe-area-inset-bottom) + 0.75rem)" }}
    >
      <Card shadow="lg">
        <CardBody className="flex-row items-center gap-3 p-4">
          <Download className="h-5 w-5 shrink-0 text-primary" aria-hidden />
          <div className="flex-1 text-sm">
            {showIosHint ? (
              <span>
                Install Ledgerly: tap <Share className="inline h-3.5 w-3.5 align-text-bottom" />{" "}
                Share, then <strong>Add to Home Screen</strong>.
              </span>
            ) : (
              <span>Install Ledgerly for faster capture.</span>
            )}
          </div>
          {deferred ? (
            <Button
              size="sm"
              color="primary"
              onPress={() => {
                void deferred.prompt();
                dismiss();
              }}
            >
              Install
            </Button>
          ) : null}
          <Button isIconOnly size="sm" variant="light" aria-label="Dismiss" onPress={dismiss}>
            <X className="h-4 w-4" />
          </Button>
        </CardBody>
      </Card>
    </div>
  );
}

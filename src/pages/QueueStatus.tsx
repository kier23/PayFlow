import { useEffect, useState, useRef, useCallback } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { getGuestId } from "../lib/getGuestId";
import Layout from "../components/Layout";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import {
  faChartBar,
  faBullseye,
  faBell,
  faTicket,
  faForward,
  faHourglassHalf,
  faCheckCircle,
  faCheck,
  faTimesCircle,
  faWifi,
  faRotateRight,
} from "@fortawesome/free-solid-svg-icons";

// Firebase is NOT imported at the top level — lazily loaded inside
// handleEnableAll to prevent iOS Safari from crashing on module load.

type Queue = {
  id: string;
  latest_number: number | null;
  cutoff_number: number | null;
};

type QueueTicket = {
  id: string;
  ticket_number: number;
  status: string;
  guest_id: string;
};

type SubStatus = "connecting" | "subscribed" | "error" | "closed";

const VAPID_KEY = import.meta.env.VITE_VAPID_KEY;
const RECONNECT_DELAY_MS = 3000;
const MAX_AUTO_RECONNECTS = 3;

// ── iOS detection helpers ─────────────────────────────────────────────────────
const isIOS = () =>
  /iPad|iPhone|iPod/.test(navigator.userAgent) && !(window as any).MSStream;

const isInStandaloneMode = () =>
  window.matchMedia("(display-mode: standalone)").matches ||
  (navigator as any).standalone === true;
// ─────────────────────────────────────────────────────────────────────────────

const QueueStatus = () => {
  const { queueId } = useParams();
  const navigate = useNavigate();

  // Guard getGuestId() — iOS Safari Private Mode blocks localStorage and throws
  const guestId = (() => {
    try {
      return getGuestId();
    } catch {
      return "";
    }
  })();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [queue, setQueue] = useState<Queue | null>(null);
  const [nextNumber, setNextNumber] = useState<number | null>(null);
  const [userTicket, setUserTicket] = useState<QueueTicket | null>(null);
  const [lastUserTicket, setLastUserTicket] = useState<QueueTicket | null>(
    null,
  );
  const [notifications, setNotifications] = useState<string[]>([]);

  // ── Subscription health ───────────────────────────────────────────────────
  const [subStatus, setSubStatus] = useState<SubStatus>("connecting");
  const reconnectAttemptsRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const channelCleanupRef = useRef<(() => void) | null>(null);
  // Mirrors userTicket state so queue-channel callbacks always read the latest value
  const userTicketRef = useRef<QueueTicket | null>(null);
  // Tracks which proximity alerts have already been fired to prevent duplicates
  const proximityNotifiedRef = useRef<Set<string>>(new Set());
  // ─────────────────────────────────────────────────────────────────────────

  // Android/Chrome install prompt
  const [deferredPrompt, setDeferredPrompt] = useState<any>(null);

  // iOS-specific UI state
  const [showIOSInstallBanner, setShowIOSInstallBanner] = useState(false);
  const [showIOSNotifNote, setShowIOSNotifNote] = useState(false);

  // Safe check — Notification API doesn't exist on iOS Safari (non-PWA)
  const notificationSupported =
    typeof window !== "undefined" && "Notification" in window;

  // ── PWA install detection ─────────────────────────────────────────────────
  useEffect(() => {
    // Android/Chrome: capture the install prompt
    const handler = (e: any) => {
      e.preventDefault();
      setDeferredPrompt(e);
    };
    window.addEventListener("beforeinstallprompt", handler);

    if (isInStandaloneMode()) {
      try {
        localStorage.setItem("pwaInstalled", "true");
      } catch {}
    }

    // iOS: show the manual install banner if not already installed as PWA
    if (isIOS() && !isInStandaloneMode()) {
      setShowIOSInstallBanner(true);
    }

    return () => window.removeEventListener("beforeinstallprompt", handler);
  }, []);

  useEffect(() => {
    window.onerror = (msg, error) => {
      console.error("Global error:", msg, error);
    };
  }, []);
  // ─────────────────────────────────────────────────────────────────────────

  const addNotification = useCallback((message: string) => {
    setNotifications((prev) => [message, ...prev].slice(0, 6));

    if ("Notification" in window && Notification.permission === "granted") {
      navigator.serviceWorker
        .getRegistration()
        .then((registration) => {
          if (registration) {
            registration.showNotification(message, {
              icon: "/PayFlow-Logo_192.png",
              badge: "/PayFlow-Logo_192.png",
            });
          }
        })
        .catch((e) => console.warn("Notification failed:", e));
    }
  }, []);

  // ── Notification / install handler ───────────────────────────────────────
  const handleEnableAll = async () => {
    // iOS Safari (not installed as PWA): notifications not supported at all
    if (isIOS() && !isInStandaloneMode()) {
      setShowIOSInstallBanner(true);
      alert(
        "To receive notifications on iPhone, first install this app:\n\n" +
          "1. Tap the Share button (□↑) in Safari\n" +
          '2. Tap "Add to Home Screen"\n' +
          "3. Open the app from your home screen\n" +
          "4. Then tap this button again to enable notifications.",
      );
      return;
    }

    // iOS PWA (iOS 16.4+): notifications supported but skip FCM — use Web Push only
    if (isIOS() && isInStandaloneMode()) {
      if (!notificationSupported) {
        alert(
          "Notifications require iOS 16.4 or later. Please update your iPhone and try again.",
        );
        return;
      }
      try {
        const permission = await Notification.requestPermission();
        if (permission === "granted") {
          setShowIOSNotifNote(true);
          alert(
            "Notifications enabled! ✅\nYou'll be notified when your number is called.",
          );
        } else {
          alert(
            "Notifications blocked. Go to Settings → Safari → Notifications and allow this site.",
          );
        }
      } catch (err: any) {
        console.error("iOS notification error:", err);
        alert(
          "Could not enable notifications: " + (err.message || "Unknown error"),
        );
      }
      return;
    }

    // Android / Desktop: full FCM flow
    if (!notificationSupported) {
      alert("Your browser doesn't support notifications.");
      return;
    }

    try {
      // Trigger Android install prompt if available
      if (deferredPrompt) {
        try {
          deferredPrompt.prompt();
          const choice = await deferredPrompt.userChoice;
          if (choice.outcome === "accepted") {
            alert(
              "App installed successfully! You can now receive notifications.",
            );
          }
          setDeferredPrompt(null);
          await new Promise((resolve) => setTimeout(resolve, 800));
        } catch (promptError) {
          console.error("Install prompt error:", promptError);
        }
      }

      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        alert(
          permission === "denied"
            ? "Notifications are blocked. Please enable them in your browser settings."
            : "Please allow notifications to receive queue updates.",
        );
        return;
      }

      const swReg = await navigator.serviceWorker.getRegistration();

      // Lazy import — prevents iOS from crashing on module load
      const { isSupported, getToken } = await import("firebase/messaging");
      const supported = await isSupported();

      if (!supported) {
        alert(
          "Push notifications are not supported on this browser.\n" +
            "You'll still receive in-app notifications while this page is open.",
        );
        return;
      }

      const { messaging } = await import("../lib/firebase");
      const token = await getToken(messaging, {
        vapidKey: VAPID_KEY,
        serviceWorkerRegistration: swReg,
      });

      if (token) {
        await supabase
          .from("Queue_Tickets")
          .update({ fcm_token: token })
          .eq("guest_id", guestId);
        alert(
          "Notifications enabled successfully! ✅\nYou'll receive updates when your number is called.",
        );
      } else {
        alert("Failed to get notification token. Please try again.");
      }
    } catch (err: any) {
      console.error("Enable notifications error:", err);
      alert(
        "Failed to enable notifications.\n\nError: " +
          (err.message || "Unknown error"),
      );
    }
  };
  // ─────────────────────────────────────────────────────────────────────────

  const fetchStatus = useCallback(async () => {
    if (!queueId) return;

    setLoading(true);
    setError(null);

    try {
      const { data: queueData, error: queueError } = await supabase
        .from("Queue")
        .select("id, latest_number, cutoff_number")
        .eq("id", queueId)
        .single();

      if (queueError || !queueData) {
        setError("Queue not found.");
        setLoading(false);
        return;
      }

      setQueue(queueData);

      const { data: tickets, error: ticketError } = await supabase
        .from("Queue_Tickets")
        .select("id, ticket_number, status, guest_id")
        .eq("queue_id", queueId)
        .order("ticket_number", { ascending: true });

      if (ticketError) {
        setError("Failed to fetch tickets.");
        setLoading(false);
        return;
      }

      const waitingTicket = (tickets || []).find((t) => t.status === "waiting");
      setNextNumber(
        waitingTicket
          ? waitingTicket.ticket_number
          : (queueData.latest_number || 0) + 1,
      );

      const activeUserTicket = (tickets || [])
        .filter(
          (t) =>
            t.guest_id === guestId && !["done", "cancelled"].includes(t.status),
        )
        .pop();

      const allUserTickets = (tickets || [])
        .filter((t) => t.guest_id === guestId)
        .sort((a, b) => b.ticket_number - a.ticket_number);

      const mostRecentTicket =
        allUserTickets.length > 0 ? allUserTickets[0] : null;

      setUserTicket(activeUserTicket || null);
      setLastUserTicket(mostRecentTicket);
    } catch (err) {
      setError("Unexpected error loading queue status.");
    }

    setLoading(false);
  }, [queueId, guestId]);

  const handleResubmitTicket = async () => {
    if (!userTicket || userTicket.status !== "skipped") return;
    const confirmResubmit = confirm(
      "This will create a new ticket with the next available number. Your skipped ticket will remain in the system. Continue?",
    );
    if (!confirmResubmit) return;
    navigate(`/queue/${queueId}`);
  };

  const handleCancelTicket = async () => {
    if (!userTicket) return;
    const confirmCancel = confirm(
      `Are you sure you want to cancel ticket #${userTicket.ticket_number}?`,
    );
    if (!confirmCancel) return;

    try {
      await supabase
        .from("Queue_Tickets")
        .update({ status: "cancelled" })
        .eq("id", userTicket.id);
      alert("Ticket cancelled successfully");
      navigate(`/queue/${queueId}`);
    } catch (err: any) {
      console.error("Cancel ticket error:", err);
      alert(err.message || "Error cancelling ticket");
    }
  };

  // Keep userTicketRef in sync so queue-channel callbacks always see the latest ticket
  useEffect(() => {
    userTicketRef.current = userTicket;
  }, [userTicket]);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  // ── Realtime subscriptions ────────────────────────────────────────────────
  const setupSubscriptions = useCallback(() => {
    if (!queueId) return () => {};

    setSubStatus("connecting");
    const suffix = Date.now();

    const queueChannel = supabase
      .channel(`queue-status-${queueId}-${suffix}`)
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "Queue",
          filter: `id=eq.${queueId}`,
        },
        (payload) => {
          console.log("Queue changed:", payload);

          // ── Proximity notifications ──────────────────────────────────
          const newLatest = payload.new?.latest_number as number | null;
          const ticket = userTicketRef.current;

          if (
            ticket &&
            ticket.status === "waiting" &&
            newLatest !== null &&
            newLatest !== undefined
          ) {
            const diff = ticket.ticket_number - newLatest;

            const notifKey5 = `5away-${ticket.id}-at-${newLatest}`;
            if (diff === 5 && !proximityNotifiedRef.current.has(notifKey5)) {
              proximityNotifiedRef.current.add(notifKey5);
              addNotification(
                `Almost your turn! 5 numbers away — ticket #${ticket.ticket_number}, get ready.`,
              );
            }

            const notifKey1 = `next-${ticket.id}-at-${newLatest}`;
            if (diff === 1 && !proximityNotifiedRef.current.has(notifKey1)) {
              proximityNotifiedRef.current.add(notifKey1);
              addNotification(
                `You're next! Ticket #${ticket.ticket_number} — please make your way to the counter.`,
              );
            }
          }
          // ─────────────────────────────────────────────────────────────

          fetchStatus();
        },
      )
      .subscribe((status) => {
        console.log("Queue channel status:", status);
        handleChannelStatus(status);
      });

    const ticketChannel = supabase
      .channel(`queue-status-tickets-${queueId}-${suffix}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "Queue_Tickets",
          filter: `queue_id=eq.${queueId}`,
        },
        (payload: any) => {
          console.log("Ticket changed:", payload);
          const newStatus = payload.new?.status;
          const oldStatus = payload.old?.status;
          const ticketGuestId = payload.new?.guest_id;

          if (ticketGuestId === guestId && newStatus !== oldStatus) {
            if (newStatus === "skipped")
              addNotification("Your ticket was skipped. Please resubmit.");
            else if (newStatus === "done")
              addNotification("Your transaction is complete. Thank you!");
          }

          fetchStatus();
        },
      )
      .subscribe((status) => {
        console.log("Ticket channel status:", status);
        handleChannelStatus(status);
      });

    return () => {
      supabase.removeChannel(queueChannel);
      supabase.removeChannel(ticketChannel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queueId, fetchStatus, guestId, addNotification]);

  const handleChannelStatus = useCallback(
    (status: string) => {
      if (status === "SUBSCRIBED") {
        setSubStatus("subscribed");
        reconnectAttemptsRef.current = 0;
        return;
      }

      if (
        status === "TIMED_OUT" ||
        status === "CLOSED" ||
        status === "CHANNEL_ERROR"
      ) {
        console.warn(`Supabase channel ${status}. Attempting reconnect…`);
        setSubStatus("closed");

        if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);

        if (reconnectAttemptsRef.current < MAX_AUTO_RECONNECTS) {
          reconnectAttemptsRef.current += 1;
          const delay = RECONNECT_DELAY_MS * reconnectAttemptsRef.current;
          reconnectTimerRef.current = setTimeout(() => {
            if (channelCleanupRef.current) channelCleanupRef.current();
            channelCleanupRef.current = setupSubscriptions();
          }, delay);
        } else {
          console.warn("Max auto-reconnect attempts reached.");
          setSubStatus("error");
        }
      }
    },
    [setupSubscriptions],
  );

  useEffect(() => {
    channelCleanupRef.current = setupSubscriptions();
    return () => {
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      if (channelCleanupRef.current) channelCleanupRef.current();
    };
  }, [setupSubscriptions]);

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        fetchStatus();
        if (subStatus !== "subscribed") {
          reconnectAttemptsRef.current = 0;
          if (channelCleanupRef.current) channelCleanupRef.current();
          channelCleanupRef.current = setupSubscriptions();
        }
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () =>
      document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, [subStatus, fetchStatus, setupSubscriptions]);

  const handleManualReconnect = () => {
    reconnectAttemptsRef.current = 0;
    if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
    if (channelCleanupRef.current) channelCleanupRef.current();
    channelCleanupRef.current = setupSubscriptions();
    fetchStatus();
  };
  // ─────────────────────────────────────────────────────────────────────────

  const userStatusText = () => {
    if (!userTicket) return "You do not have an active ticket for this queue.";
    if (userTicket.status === "serving")
      return `You are being served now with ticket #${userTicket.ticket_number}.`;
    if (userTicket.status === "skipped")
      return `Your ticket #${userTicket.ticket_number} was skipped. Please resubmit to get a new ticket.`;
    return `Your ticket: #${userTicket.ticket_number} (status: ${userTicket.status}).`;
  };

  // Derive button label/disabled state safely (Notification may not exist on iOS Safari)
  const notifGranted =
    notificationSupported && Notification.permission === "granted";
  const iosNotInstalled = isIOS() && !isInStandaloneMode();

  return (
    <Layout showNavigation={false}>
      <div className="min-h-screen bg-gradient-to-br from-background via-orange-50/30 to-background py-12 px-4">
        <div className="w-full max-w-4xl mx-auto">
          {/* ── iOS Install Banner ────────────────────────────────────────── */}
          {showIOSInstallBanner && (
            <div className="mb-6 bg-blue-50 border border-blue-200 rounded-2xl p-4 flex gap-3 items-start">
              <span className="text-2xl">📱</span>
              <div className="flex-1">
                <p className="font-bold text-blue-900 text-sm">
                  Install this app on your iPhone
                </p>
                <p className="text-blue-700 text-xs mt-1">
                  Tap the <strong>Share</strong> button (□↑) in Safari, then tap{" "}
                  <strong>"Add to Home Screen"</strong> to install and enable
                  notifications.
                </p>
              </div>
              <button
                onClick={() => setShowIOSInstallBanner(false)}
                className="text-blue-400 hover:text-blue-600 text-lg font-bold shrink-0"
              >
                ✕
              </button>
            </div>
          )}
          {/* ─────────────────────────────────────────────────────────────── */}

          {/* Header */}
          <div className="mb-8 flex flex-col sm:flex-row justify-between items-center gap-4">
            <div className="flex items-center gap-4">
              <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-primary to-orange-700 flex items-center justify-center shadow-lg">
                <FontAwesomeIcon
                  icon={faChartBar}
                  className="text-2xl text-white"
                />
              </div>
              <div>
                <h2 className="text-3xl font-bold bg-gradient-to-r from-primary via-orange-600 to-black bg-clip-text text-transparent">
                  Queue Status
                </h2>
                <p className="text-gray-500 text-sm">
                  Real-time queue information
                </p>
              </div>
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => navigate("/")}
                className="px-4 py-3 bg-white hover:bg-gray-50 text-gray-800 rounded-xl font-semibold shadow-md hover:shadow-lg transition-all border border-gray-200"
              >
                ← Home
              </button>
              <button
                onClick={() => navigate(`/queue/${queueId}`)}
                className="px-6 py-3 bg-white hover:bg-gray-50 text-gray-800 rounded-xl font-semibold shadow-md hover:shadow-lg transition-all border border-gray-200"
              >
                ← Back to Ticket
              </button>
            </div>
          </div>

          {/* ── Subscription status banners ───────────────────────────────── */}
          {subStatus === "connecting" && (
            <div className="mb-4 flex items-center gap-3 bg-blue-50 border border-blue-200 text-blue-700 px-4 py-3 rounded-xl text-sm font-medium">
              <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-blue-500 shrink-0" />
              Connecting to live updates…
            </div>
          )}
          {subStatus === "closed" && (
            <div className="mb-4 flex items-center gap-3 bg-yellow-50 border border-yellow-300 text-yellow-800 px-4 py-3 rounded-xl text-sm font-medium">
              <FontAwesomeIcon icon={faWifi} className="shrink-0" />
              <span>
                Live updates disconnected — reconnecting automatically…
              </span>
              <div className="ml-auto animate-spin rounded-full h-4 w-4 border-b-2 border-yellow-600 shrink-0" />
            </div>
          )}
          {subStatus === "error" && (
            <div className="mb-4 flex flex-col sm:flex-row items-start sm:items-center gap-3 bg-red-50 border border-red-300 text-red-800 px-4 py-3 rounded-xl text-sm font-medium">
              <FontAwesomeIcon
                icon={faWifi}
                className="shrink-0 mt-0.5 sm:mt-0"
              />
              <span className="flex-1">
                Live updates are <strong>not active</strong>. You may miss
                real-time changes until you reconnect.
              </span>
              <button
                onClick={handleManualReconnect}
                className="flex items-center gap-2 px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded-lg font-semibold shadow transition-all text-xs whitespace-nowrap"
              >
                <FontAwesomeIcon icon={faRotateRight} />
                Reconnect
              </button>
            </div>
          )}
          {/* ─────────────────────────────────────────────────────────────── */}

          {loading && (
            <div className="flex items-center justify-center py-20">
              <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary"></div>
            </div>
          )}
          {error && (
            <div className="bg-red-50 border border-red-200 text-red-700 px-6 py-4 rounded-xl">
              {error}
            </div>
          )}

          {!loading && !error && (
            <div className="bg-white rounded-3xl shadow-2xl p-4 md:p-8 lg:p-10 space-y-4 md:space-y-6 lg:space-y-8 border border-primary/20">
              {/* Status Cards Grid */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4 md:gap-6">
                {/* Notification / Install Button */}
                <div className="text-center mb-6">
                  <button
                    onClick={handleEnableAll}
                    disabled={notifGranted && !iosNotInstalled}
                    className="px-6 py-4 bg-gradient-to-r from-primary via-orange-600 to-primary text-white rounded-xl font-bold shadow-lg hover:shadow-xl hover:scale-105 transition-all disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:scale-100"
                  >
                    {notifGranted
                      ? "🔔 Notifications Enabled"
                      : iosNotInstalled
                        ? "📱 Install App for Notifications"
                        : "🔔 Enable Notifications & Install App"}
                  </button>

                  {/* iOS: not yet installed — show hint */}
                  {iosNotInstalled && (
                    <p className="text-xs text-blue-600 mt-2 font-medium">
                      Tap Share (□↑) → "Add to Home Screen" in Safari
                    </p>
                  )}

                  {/* iOS PWA: after enabling notifications */}
                  {isIOS() && isInStandaloneMode() && showIOSNotifNote && (
                    <p className="text-xs text-green-600 mt-2 font-medium">
                      ✅ You'll receive in-app alerts when your number is
                      called.
                    </p>
                  )}

                  {/* Android: install prompt not ready yet */}
                  {!deferredPrompt && !isIOS() && !notifGranted && (
                    <p className="text-xs text-gray-500 mt-2">
                      Install prompt will appear after visiting the site a few
                      times
                    </p>
                  )}
                </div>

                {/* Now Serving */}
                <div className="bg-gradient-to-br from-primary via-orange-600 to-primary text-white rounded-2xl p-8 text-center shadow-xl hover:shadow-2xl transition-all transform hover:scale-105">
                  <div className="flex items-center justify-center gap-2 mb-3">
                    <FontAwesomeIcon icon={faBullseye} className="text-3xl" />
                    <p className="uppercase tracking-wide opacity-90 font-semibold text-sm">
                      Now Serving
                    </p>
                  </div>
                  <h3 className="text-6xl font-extrabold drop-shadow-lg">
                    {queue?.latest_number ?? "--"}
                  </h3>
                </div>

                {/* Next Number */}
                <div className="bg-gradient-to-br from-primary/90 via-orange-500 to-primary/90 text-white rounded-2xl p-8 text-center shadow-xl hover:shadow-2xl transition-all transform hover:scale-105">
                  <div className="flex items-center justify-center gap-2 mb-3">
                    <FontAwesomeIcon icon={faForward} className="text-3xl" />
                    <p className="uppercase tracking-wide opacity-90 font-semibold text-sm">
                      Next Number
                    </p>
                  </div>
                  <h3 className="text-6xl font-extrabold drop-shadow-lg">
                    {nextNumber ?? "--"}
                  </h3>
                </div>

                {/* Your Ticket Card */}
                <div
                  className={`rounded-2xl border-2 shadow-xl transition-all transform hover:scale-105 relative overflow-hidden ${
                    lastUserTicket?.status === "waiting"
                      ? "bg-gradient-to-br from-yellow-50 to-orange-50 border-yellow-300"
                      : lastUserTicket?.status === "serving"
                        ? "bg-gradient-to-br from-green-50 to-emerald-50 border-green-300"
                        : lastUserTicket?.status === "done"
                          ? "bg-gradient-to-br from-blue-50 to-cyan-50 border-blue-300"
                          : lastUserTicket?.status === "skipped"
                            ? "bg-gradient-to-br from-red-50 to-pink-50 border-red-300"
                            : lastUserTicket?.status === "cancelled"
                              ? "bg-gradient-to-br from-gray-50 to-slate-50 border-gray-300"
                              : "bg-white border-primary"
                  }`}
                >
                  {lastUserTicket && (
                    <>
                      {/* Top Status Bar */}
                      <div
                        className={`absolute top-0 left-0 w-full h-1 ${
                          lastUserTicket.status === "waiting"
                            ? "bg-yellow-500"
                            : lastUserTicket.status === "serving"
                              ? "bg-green-500"
                              : lastUserTicket.status === "done"
                                ? "bg-blue-500"
                                : lastUserTicket.status === "skipped"
                                  ? "bg-red-500"
                                  : lastUserTicket.status === "cancelled"
                                    ? "bg-gray-500"
                                    : "bg-primary"
                        }`}
                      />

                      {/* Status Badge */}
                      <div className="absolute top-3 right-3 px-3 py-1 bg-white/90 backdrop-blur-sm rounded-full shadow-md">
                        <span
                          className={`text-xs font-bold uppercase ${
                            lastUserTicket.status === "waiting"
                              ? "text-yellow-700"
                              : lastUserTicket.status === "serving"
                                ? "text-green-700"
                                : lastUserTicket.status === "done"
                                  ? "text-blue-700"
                                  : lastUserTicket.status === "skipped"
                                    ? "text-red-700"
                                    : lastUserTicket.status === "cancelled"
                                      ? "text-gray-700"
                                      : "text-gray-700"
                          }`}
                        >
                          {lastUserTicket.status === "waiting" && (
                            <>
                              <FontAwesomeIcon
                                icon={faHourglassHalf}
                                className="mr-1"
                              />{" "}
                              Waiting
                            </>
                          )}
                          {lastUserTicket.status === "serving" && (
                            <>
                              <FontAwesomeIcon
                                icon={faCheckCircle}
                                className="mr-1"
                              />{" "}
                              Serving
                            </>
                          )}
                          {lastUserTicket.status === "done" && (
                            <>
                              <FontAwesomeIcon
                                icon={faCheck}
                                className="mr-1"
                              />{" "}
                              Done
                            </>
                          )}
                          {lastUserTicket.status === "skipped" && (
                            <>
                              <FontAwesomeIcon
                                icon={faForward}
                                className="mr-1"
                              />{" "}
                              Skipped
                            </>
                          )}
                          {lastUserTicket.status === "cancelled" && (
                            <>
                              <FontAwesomeIcon
                                icon={faTimesCircle}
                                className="mr-1"
                              />{" "}
                              Cancelled
                            </>
                          )}
                        </span>
                      </div>
                    </>
                  )}

                  {/* Main Content */}
                  <div className="p-6 md:p-8">
                    <p className="uppercase tracking-wide text-gray-500 font-semibold text-sm mb-4">
                      Your Ticket
                    </p>

                    {userTicket ? (
                      <>
                        <h3 className="text-5xl font-extrabold text-primary mb-4">
                          #{userTicket.ticket_number}
                        </h3>
                        <p className="text-gray-600 text-sm leading-relaxed mb-4">
                          {userStatusText()}
                        </p>
                        {userTicket.status !== "done" &&
                          userTicket.status !== "cancelled" && (
                            <button
                              onClick={handleCancelTicket}
                              className="w-full px-4 py-3 bg-red-600 hover:bg-red-700 text-white rounded-xl font-semibold shadow-md hover:shadow-lg transition-all text-sm md:text-base"
                            >
                              Cancel Ticket
                            </button>
                          )}
                      </>
                    ) : lastUserTicket ? (
                      <>
                        <div className="flex items-center justify-center gap-3 mb-4">
                          <div
                            className={`w-12 h-12 md:w-16 md:h-16 rounded-full flex items-center justify-center ${
                              lastUserTicket.status === "waiting"
                                ? "bg-yellow-500"
                                : lastUserTicket.status === "serving"
                                  ? "bg-green-500"
                                  : lastUserTicket.status === "done"
                                    ? "bg-blue-500"
                                    : lastUserTicket.status === "skipped"
                                      ? "bg-red-500"
                                      : "bg-gray-500"
                            }`}
                          >
                            <span className="text-white font-bold text-xl md:text-2xl">
                              #{lastUserTicket.ticket_number}
                            </span>
                          </div>
                        </div>
                        <p className="font-bold text-gray-800 text-base md:text-lg uppercase tracking-wide mb-2">
                          {lastUserTicket.status === "waiting" && (
                            <>
                              <FontAwesomeIcon
                                icon={faHourglassHalf}
                                className="mr-2"
                              />{" "}
                              Waiting in Line
                            </>
                          )}
                          {lastUserTicket.status === "serving" && (
                            <>
                              <FontAwesomeIcon
                                icon={faCheckCircle}
                                className="mr-2"
                              />{" "}
                              Being Served Now
                            </>
                          )}
                          {lastUserTicket.status === "done" && (
                            <>
                              <FontAwesomeIcon
                                icon={faCheck}
                                className="mr-2"
                              />{" "}
                              Completed
                            </>
                          )}
                          {lastUserTicket.status === "skipped" && (
                            <>
                              <FontAwesomeIcon
                                icon={faForward}
                                className="mr-2"
                              />{" "}
                              Skipped
                            </>
                          )}
                          {lastUserTicket.status === "cancelled" && (
                            <>
                              <FontAwesomeIcon
                                icon={faTimesCircle}
                                className="mr-2"
                              />{" "}
                              Cancelled
                            </>
                          )}
                        </p>
                        <p className="text-xs md:text-sm text-gray-600 mb-4">
                          {lastUserTicket.status === "waiting" &&
                            `You're in line for queue ${queueId}`}
                          {lastUserTicket.status === "serving" &&
                            "Please proceed to the counter"}
                          {lastUserTicket.status === "done" &&
                            "Your transaction has been completed"}
                          {lastUserTicket.status === "skipped" &&
                            "You missed your turn. Please resubmit."}
                          {lastUserTicket.status === "cancelled" &&
                            "You cancelled this ticket"}
                        </p>
                        {lastUserTicket.status === "skipped" && (
                          <button
                            onClick={handleResubmitTicket}
                            className="w-full px-4 py-3 bg-red-600 hover:bg-red-700 text-white rounded-xl font-semibold shadow-md hover:shadow-lg transition-all text-sm md:text-base"
                          >
                            🔄 Resubmit Ticket
                          </button>
                        )}
                      </>
                    ) : (
                      <>
                        <h3 className="text-4xl md:text-5xl font-extrabold text-gray-400 mb-4">
                          --
                        </h3>
                        <p className="text-gray-600 text-sm leading-relaxed">
                          You do not have an active ticket for this queue.
                        </p>
                        <button
                          onClick={() => navigate(`/queue/${queueId}`)}
                          className="mt-4 w-full px-4 py-3 bg-gradient-to-r from-primary via-orange-600 to-primary text-white rounded-xl font-semibold shadow-md hover:shadow-lg transition-all text-sm md:text-base"
                        >
                          Create a Ticket
                        </button>
                      </>
                    )}
                  </div>
                </div>
              </div>

              {/* Notifications */}
              {!!notifications.length && (
                <div className="rounded-2xl border-2 border-primary/20 p-4 md:p-6 bg-gradient-to-br from-blue-50/50 to-cyan-50/50">
                  <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3 mb-4">
                    <div className="flex items-center gap-3">
                      <FontAwesomeIcon
                        icon={faBell}
                        className="text-2xl text-primary"
                      />
                      <span className="font-bold text-gray-800 text-lg">
                        Recent Notifications
                      </span>
                    </div>
                    <button
                      className="w-full sm:w-auto px-4 py-2.5 bg-white hover:bg-gray-50 text-primary rounded-lg font-semibold text-sm transition-all shadow-md hover:shadow-lg border border-gray-200"
                      onClick={() => setNotifications([])}
                    >
                      Clear All
                    </button>
                  </div>
                  <ul className="space-y-2">
                    {notifications.map((msg, idx) => (
                      <li
                        key={`${idx}-${msg}`}
                        className="rounded-xl px-4 py-3 bg-white border border-gray-200 shadow-sm hover:shadow-md transition-all flex items-center gap-3"
                      >
                        <span className="text-green-500">✓</span>
                        <span className="text-gray-800 font-medium">{msg}</span>
                      </li>
                    ))}
                  </ul>

                  {/* Cutoff Information */}
                  {queue?.cutoff_number !== null &&
                    queue?.cutoff_number !== undefined &&
                    queue.cutoff_number > 0 && (
                      <div className="mt-4 pt-4 border-t border-purple-200">
                        <div className="flex items-center gap-3 bg-purple-50 border border-purple-200 p-4 rounded-xl">
                          <div className="w-10 h-10 rounded-full bg-purple-100 flex items-center justify-center shrink-0">
                            <span className="text-xl">✂</span>
                          </div>
                          <div className="flex-1">
                            <p className="text-sm font-bold text-purple-900">
                              End-of-Day Cutoff Active
                            </p>
                            <p className="text-xs text-purple-700 mt-1">
                              Serving for{" "}
                              <span className="font-bold">
                                {queue.cutoff_number} more ticket
                                {queue.cutoff_number !== 1 ? "s" : ""}
                              </span>{" "}
                              today
                            </p>
                            {queue.latest_number && (
                              <p className="text-xs text-purple-600 mt-1">
                                Current: #{queue.latest_number} • Cutoff after:
                                #{queue.latest_number + queue.cutoff_number}
                              </p>
                            )}
                          </div>
                        </div>
                      </div>
                    )}
                </div>
              )}

              {/* No Ticket Action */}
              {!userTicket && (
                <div className="text-center pt-6 border-t border-gray-100">
                  <div className="inline-flex items-center gap-2 mb-4 text-gray-600">
                    <FontAwesomeIcon
                      icon={faTicket}
                      className="text-3xl text-primary"
                    />
                    <p className="font-medium">
                      You don't have an active ticket for this queue
                    </p>
                  </div>
                  <button
                    onClick={() => navigate(`/queue/${queueId}`)}
                    className="px-8 py-4 bg-gradient-to-r from-primary via-orange-600 to-primary text-white rounded-xl font-bold text-base shadow-lg hover:shadow-xl hover:scale-105 transition-all"
                  >
                    <FontAwesomeIcon icon={faTicket} className="mr-2" /> Create
                    a Ticket
                  </button>
                </div>
              )}

              {/* Resubmit Skipped Ticket */}
              {userTicket && userTicket.status === "skipped" && (
                <div className="text-center pt-6 border-t border-gray-100">
                  <div className="inline-flex items-center gap-2 mb-4 text-red-600">
                    <FontAwesomeIcon icon={faForward} className="text-3xl" />
                    <p className="font-bold">
                      Your ticket was skipped. Resubmit to get a new number.
                    </p>
                  </div>
                  <button
                    onClick={handleResubmitTicket}
                    className="px-8 py-4 bg-gradient-to-r from-red-600 via-orange-600 to-red-600 text-white rounded-xl font-bold text-base shadow-lg hover:shadow-xl hover:scale-105 transition-all"
                  >
                    <FontAwesomeIcon icon={faTicket} className="mr-2" />{" "}
                    Resubmit Ticket
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </Layout>
  );
};

export default QueueStatus;

import { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { supabase } from "../lib/supabase";
import Layout from "../components/Layout";
import Speech from "speak-tts";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import {
  faSlidersH,
  faHourglassHalf,
  faBullseye,
  faChartBar,
  faList,
  faVolumeUp,
  faMobileAlt,
} from "@fortawesome/free-solid-svg-icons";

type Queue = {
  id: string;
  status: string;
  date: string;
  managed_by: string;
  latest_number: number | null;
  cutoff_number: number | null;
};

type TicketStatus = "waiting" | "serving" | "done" | "skipped" | "cancelled";

type Ticket = {
  id: string;
  ticket_number: number;
  client_name: string;
  status: TicketStatus;
};

const ManageQueue = () => {
  const { queueId } = useParams();
  const navigate = useNavigate();
  const [processing, setProcessing] = useState(false);
  const [autoAdvanceTimer, setAutoAdvanceTimer] = useState<number | null>(null);
  const [countdown, setCountdown] = useState<number>(5);
  const [showCutoffModal, setShowCutoffModal] = useState(false);
  const [cutoffIncrement, setCutoffIncrement] = useState<number | null>(null);
  const [customCutoffValue, setCustomCutoffValue] = useState<string>("");

  const [queue, setQueue] = useState<Queue | null>(null);
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [currentServing, setCurrentServing] = useState<Ticket | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const speech = new Speech();

  const speakNumber = async (number: number) => {
    const text = `Now serving number ${number}`;

    try {
      if (!speech.hasBrowserSupport()) {
        console.error("Browser does not support speech synthesis");
        return;
      }

      await speech.init({
        voice: "Microsoft Zira - English (United States)",
        volume: 1,
        lang: "en-US",
        rate: 1,
        pitch: 1,
        splitSentences: true,
      });
      speech.speak({
        text,
        queue: false,
      });
    } catch (err) {
      console.error("TTS error:", err);
    }
  };

  useEffect(() => {
    const fetchData = async () => {
      setLoading(true);

      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (!user) {
        navigate("/");
        return;
      }

      const { data: profile } = await supabase
        .from("Profiles")
        .select("*")
        .eq("id", user.id)
        .single();

      if (!profile || profile.role !== "admin") {
        setError("Unauthorized");
        setLoading(false);
        return;
      }

      // 🔐 Secure queue ownership
      const { data: queueData, error: queueError } = await supabase
        .from("Queue")
        .select("*")
        .eq("id", queueId)
        .eq("managed_by", profile.id)
        .single();

      if (queueError || !queueData) {
        setError("Queue not found");
        setLoading(false);
        return;
      }

      setQueue(queueData);

      await fetchTickets();

      setLoading(false);
    };

    fetchData();
  }, [queueId, navigate]);

  // 🔴 REALTIME SUBSCRIPTIONS
  useEffect(() => {
    if (!queueId) return;

    // Subscribe to Queue_Tickets changes
    const ticketsChannel = supabase
      .channel("manage-queue-tickets")
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "Queue_Tickets",
          filter: `queue_id=eq.${queueId}`,
        },
        async () => {
          await fetchTickets();
        },
      )
      .subscribe();

    // Subscribe to Queue updates (latest_number, status, etc.)
    const queueChannel = supabase
      .channel("manage-queue-main")
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "Queue",
          filter: `id=eq.${queueId}`,
        },
        (payload) => {
          setQueue(payload.new as Queue);
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(ticketsChannel);
      supabase.removeChannel(queueChannel);
    };
  }, [queueId]);

  const fetchTickets = async () => {
    const { data } = await supabase
      .from("Queue_Tickets")
      .select("*")
      .eq("queue_id", queueId)
      .order("ticket_number", { ascending: true });

    const ticketList = data || [];
    setTickets(ticketList);

    const { data: freshQueue } = await supabase
      .from("Queue")
      .select("latest_number")
      .eq("id", queueId)
      .single();

    const serving = ticketList.find(
      (t) => t.ticket_number === freshQueue?.latest_number,
    );
    setCurrentServing(serving || null);
  };

  const sendQueueNotifications = async (latestNumber: number) => {
    if (!queueId) return;
    const notified = new Set<number>();

    try {
      // 1. Get waiting tickets
      const { data: tickets, error: ticketsError } = await supabase
        .from("Queue_Tickets")
        .select("ticket_number, guest_id, fcm_token")
        .eq("queue_id", queueId)
        .eq("status", "waiting");

      if (ticketsError) {
        console.error(
          "Failed to fetch tickets for notifications:",
          ticketsError,
        );
        return;
      }

      if (!tickets || tickets.length === 0) return;

      console.log(`Sending notifications to ${tickets.length} waiting tickets`);

      for (const ticket of tickets) {
        try {
          const fcmToken = ticket.fcm_token;

          console.log(
            `Ticket #${ticket.ticket_number} | latest: ${latestNumber} | token:`,
            fcmToken,
          );

          if (!fcmToken) {
            console.log(
              `No FCM token for ticket #${ticket.ticket_number}, skipping`,
            );
            continue;
          }
          // 🚫 Skip invalid or already passed tickets
          if (ticket.ticket_number <= latestNumber) {
            console.log(
              `⏭️ Skip #${ticket.ticket_number} - already passed (latest: ${latestNumber})`,
            );
            continue;
          }

          if (notified.has(ticket.ticket_number)) {
            console.log(`⏭️ Skip #${ticket.ticket_number} - already notified`);
            continue;
          }
          notified.add(ticket.ticket_number);

          // 🎯 EXACT CONDITIONS (FIXED - calculate difference correctly)
          const diff = ticket.ticket_number - latestNumber;
          const isFiveAway = diff === 5;
          const isNext = diff === 1;

          console.log(
            `📍 Ticket #${ticket.ticket_number} | diff: ${diff} | isFiveAway: ${isFiveAway} | isNext: ${isNext}`,
          );

          if (!isFiveAway && !isNext) {
            console.log(
              `⏭️ Skip #${ticket.ticket_number} - not at trigger point`,
            );
            continue;
          }

          // 🔔 Message + title
          const message = isNext
            ? `You're next! (#${ticket.ticket_number})`
            : `You're 5 numbers away! (#${ticket.ticket_number})`;

          const title = isNext ? "Your Turn!" : "Queue Update";

          // 🚀 SEND PUSH
          const response = await fetch(
            "https://edfshthhipqcofhixayr.supabase.co/functions/v1/send-push",
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`,
              },
              body: JSON.stringify({
                token: fcmToken,
                message,
                title,
                link: `/queue/${queueId}/status`,
              }),
            },
          );

          // 🧪 DEBUG (IMPORTANT)
          const result = await response.json();

          console.log("FCM RESPONSE:", result);

          if (!response.ok) {
            console.error("Push failed:", result);
          }
          console.log(`Push result for #${ticket.ticket_number}:`, result);

          if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
          }
        } catch (err) {
          console.error(
            `Failed to send notification to ticket #${ticket.ticket_number}:`,
            err,
          );
        }
      }

      console.log("Notification sending complete");
    } catch (err) {
      console.error("sendQueueNotifications error:", err);
    }
  };

  const callNext = async () => {
    if (!queue || processing) return;
    setProcessing(true);

    try {
      // 1. Finish current
      if (currentServing) {
        await supabase
          .from("Queue_Tickets")
          .update({ status: "done" })
          .eq("id", currentServing.id);
      }

      // 2. Get next waiting ticket (skip cancelled ones)
      const { data: nextTicket, error } = await supabase
        .from("Queue_Tickets")
        .select("*")
        .eq("queue_id", queue.id)
        .gt("ticket_number", queue.latest_number ?? 0)
        .eq("status", "waiting")
        .order("ticket_number", { ascending: true })
        .limit(1)
        .maybeSingle();

      if (error) {
        console.error("Fetch next ticket error:", error);
        return;
      }

      // ❗ If no next ticket → STOP (DON'T SET NULL)
      if (!nextTicket) {
        console.log("No more tickets");

        // ✅ Keep latest_number as is (last served)
        setCurrentServing(null); // UI shows no one is serving
        // queue.latest_number stays unchanged
        return;
      }

      // 3. Mark next ticket as serving
      await supabase
        .from("Queue_Tickets")
        .update({ status: "serving" })
        .eq("id", nextTicket.id);

      // 4. Update queue latest_number (THIS IS THE KEY FIX)
      const { data: updatedQueue, error: updateError } = await supabase
        .from("Queue")
        .update({
          latest_number: nextTicket.ticket_number, // ✅ ALWAYS NUMBER
        })
        .eq("id", queue.id)
        .select()
        .single();

      if (updateError) {
        console.error("Queue update failed:", updateError);
        return;
      }

      // 5. Update UI
      setQueue(updatedQueue);
      setCurrentServing(nextTicket);
      speakNumber(nextTicket.ticket_number);

      // 6. Refresh tickets
      await sendQueueNotifications(nextTicket.ticket_number);
      await fetchTickets();
    } finally {
      setProcessing(false);
    }
  };

  const startAutoAdvance = () => {
    if (autoAdvanceTimer || processing) return;

    setCountdown(5);
    const timer = window.setInterval(() => {
      setCountdown((prev) => {
        if (prev <= 1) {
          // Timer reached 0, call next
          window.clearInterval(timer);
          setAutoAdvanceTimer(null);
          callNext();
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    setAutoAdvanceTimer(timer);
  };

  const cancelAutoAdvance = () => {
    if (autoAdvanceTimer) {
      window.clearInterval(autoAdvanceTimer);
      setAutoAdvanceTimer(null);
      setCountdown(5);
    }
  };

  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      if (autoAdvanceTimer) {
        window.clearInterval(autoAdvanceTimer);
      }
    };
  }, [autoAdvanceTimer]);

  const skipCurrent = async () => {
    if (!queue || !currentServing || processing) return;
    setProcessing(true);

    try {
      await supabase
        .from("Queue_Tickets")
        .update({ status: "skipped" })
        .eq("id", currentServing.id);

      const { data: nextTicket } = await supabase
        .from("Queue_Tickets")
        .select("*")
        .eq("queue_id", queue.id)
        .eq("status", "waiting")
        .gt("ticket_number", currentServing.ticket_number)
        .order("ticket_number", { ascending: true })
        .limit(1)
        .maybeSingle();

      if (!nextTicket) {
        await supabase
          .from("Queue")
          .update({ latest_number: null })
          .eq("id", queue.id);

        setQueue((prev) => (prev ? { ...prev, latest_number: null } : prev));
        setCurrentServing(null);
      } else {
        await supabase
          .from("Queue_Tickets")
          .update({ status: "serving" })
          .eq("id", nextTicket.id);

        await supabase
          .from("Queue")
          .update({ latest_number: nextTicket.ticket_number })
          .eq("id", queue.id);

        setQueue((prev) =>
          prev ? { ...prev, latest_number: nextTicket.ticket_number } : prev,
        );
        setCurrentServing(nextTicket);

        // Send notifications for the new serving ticket
        await sendQueueNotifications(nextTicket.ticket_number);
      }

      await fetchTickets();
      const { data: updatedQueue } = await supabase
        .from("Queue")
        .select("*")
        .eq("id", queue.id)
        .single();
      if (updatedQueue) setQueue(updatedQueue);

      // playSound(); // disabled for testing number update only
    } finally {
      setProcessing(false);
    }
  };

  const cancelCurrent = async () => {
    if (!queue || !currentServing || processing) return;
    setProcessing(true);

    try {
      // Mark current ticket as cancelled
      await supabase
        .from("Queue_Tickets")
        .update({ status: "cancelled" })
        .eq("id", currentServing.id);

      // Find next waiting ticket (automatically skips cancelled ones)
      const { data: nextTicket } = await supabase
        .from("Queue_Tickets")
        .select("*")
        .eq("queue_id", queue.id)
        .eq("status", "waiting")
        .gt("ticket_number", currentServing.ticket_number)
        .order("ticket_number", { ascending: true })
        .limit(1)
        .maybeSingle();

      if (!nextTicket) {
        await supabase
          .from("Queue")
          .update({ latest_number: null })
          .eq("id", queue.id);

        setQueue((prev) => (prev ? { ...prev, latest_number: null } : prev));
        setCurrentServing(null);
      } else {
        await supabase
          .from("Queue_Tickets")
          .update({ status: "serving" })
          .eq("id", nextTicket.id);

        await supabase
          .from("Queue")
          .update({ latest_number: nextTicket.ticket_number })
          .eq("id", queue.id);

        setQueue((prev) =>
          prev ? { ...prev, latest_number: nextTicket.ticket_number } : prev,
        );
        setCurrentServing(nextTicket);

        // Send notifications for the new serving ticket
        await sendQueueNotifications(nextTicket.ticket_number);
      }

      await fetchTickets();
      const { data: updatedQueue } = await supabase
        .from("Queue")
        .select("*")
        .eq("id", queue.id)
        .single();
      if (updatedQueue) setQueue(updatedQueue);
    } finally {
      setProcessing(false);
    }
  };
  const waitingCount = tickets.filter((t) => t.status === "waiting").length;

  const handleCutoffClick = () => {
    setShowCutoffModal(true);
  };

  const handleCutoffIncrementSelect = async (increment: number) => {
    if (!queue) return;

    // Store the number of tickets remaining before cutoff (not the ticket number)
    const ticketsRemainingBeforeCutoff = increment;

    // Update queue with cutoff number (number of tickets left before cutoff)
    const { data: updatedQueue, error } = await supabase
      .from("Queue")
      .update({
        cutoff_number: ticketsRemainingBeforeCutoff,
      })
      .eq("id", queue.id)
      .select()
      .single();

    if (error) {
      console.error("Failed to update cutoff number:", error);
      return;
    }

    setQueue(updatedQueue);
    setCutoffIncrement(increment);
    setShowCutoffModal(false);
  };

  const handleSetCustomCutoff = async (customNumber: number) => {
    if (!queue) return;

    const currentNumber = queue.latest_number || 0;
    // Calculate number of tickets remaining before cutoff
    const ticketsRemainingBeforeCutoff = customNumber - currentNumber;

    // Update queue with cutoff number (number of tickets left before cutoff)
    const { data: updatedQueue, error } = await supabase
      .from("Queue")
      .update({
        cutoff_number: ticketsRemainingBeforeCutoff,
      })
      .eq("id", queue.id)
      .select()
      .single();

    if (error) {
      console.error("Failed to update cutoff number:", error);
      return;
    }

    setQueue(updatedQueue);
    setShowCutoffModal(false);
  };

  const handleRemoveCutoff = async () => {
    if (!queue) return;

    const { data: updatedQueue } = await supabase
      .from("Queue")
      .update({
        cutoff_number: null,
      })
      .eq("id", queue.id)
      .select()
      .single();

    if (updatedQueue) {
      setQueue(updatedQueue);
      setCutoffIncrement(null);
    }
  };

  return (
    <Layout showNavigation={false}>
      <div className="min-h-screen bg-linear-to-br from-background via-orange-50/30 to-background py-8 px-4">
        <div className="max-w-7xl mx-auto space-y-6">
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

          {queue && (
            <>
              {/* HEADER */}
              <div className="bg-white rounded-3xl shadow-xl p-6 md:p-8 flex flex-col md:flex-row justify-between items-center gap-4 border border-primary/20">
                <div className="flex items-center gap-4">
                  <div className="w-14 h-14 rounded-2xl bg-linear-to-br from-primary to-orange-700 flex items-center justify-center shadow-lg">
                    <FontAwesomeIcon
                      icon={faSlidersH}
                      className="text-2xl text-white"
                    />
                  </div>
                  <div>
                    <h2 className="text-2xl md:text-3xl font-bold bg-linear-to-r from-primary via-orange-600 to-black bg-clip-text text-transparent">
                      Queue Control Panel
                    </h2>
                    <p className="text-gray-500 text-sm mt-1">
                      Queue ID:{" "}
                      <span className="font-mono font-semibold">
                        {queue.id}
                      </span>
                    </p>
                  </div>
                </div>

                <button
                  onClick={() => navigate(-1)}
                  className="px-6 py-3 bg-gray-100 hover:bg-gray-200 rounded-xl transition font-semibold text-gray-700 shadow-md hover:shadow-lg"
                >
                  ← Back
                </button>
              </div>

              {/* CURRENT NUMBER DISPLAY */}
              <div className="bg-linear-to-br from-primary via-orange-600 to-primary text-white rounded-3xl shadow-2xl p-10 md:p-14 text-center border border-primary/30">
                <p className="text-lg md:text-xl opacity-90 font-semibold tracking-wide">
                  NOW SERVING
                </p>
                <h1 className="text-7xl md:text-9xl font-extrabold mt-4 drop-shadow-lg">
                  {queue?.latest_number ?? "--"}
                </h1>
                <p className="mt-4 text-lg md:text-xl opacity-90 font-medium">
                  {currentServing?.client_name || "Waiting for next ticket..."}
                </p>
              </div>

              {/* STATS */}
              <div className="grid md:grid-cols-3 gap-6">
                <div className="bg-white rounded-2xl p-6 shadow-lg border border-primary/20 hover:shadow-xl transition-all">
                  <div className="flex items-center gap-3 mb-3">
                    <div className="w-10 h-10 rounded-xl bg-yellow-100 flex items-center justify-center">
                      <FontAwesomeIcon
                        icon={faHourglassHalf}
                        className="text-2xl text-yellow-600"
                      />
                    </div>
                    <p className="text-gray-500 font-semibold">Waiting</p>
                  </div>
                  <h3 className="text-4xl font-extrabold text-primary">
                    {waitingCount}
                  </h3>
                </div>

                <div className="bg-white rounded-2xl p-6 shadow-lg border border-primary/20 hover:shadow-xl transition-all">
                  <div className="flex items-center gap-3 mb-3">
                    <div className="w-10 h-10 rounded-xl bg-green-100 flex items-center justify-center">
                      <FontAwesomeIcon
                        icon={faBullseye}
                        className="text-2xl text-green-600"
                      />
                    </div>
                    <p className="text-gray-500 font-semibold">
                      Currently Serving
                    </p>
                  </div>
                  <h3 className="text-4xl font-extrabold text-primary">
                    {currentServing ? `#${currentServing.ticket_number}` : "-"}
                  </h3>
                </div>

                <div className="bg-white rounded-2xl p-6 shadow-lg border border-primary/20 hover:shadow-xl transition-all">
                  <div className="flex items-center gap-3 mb-3">
                    <div className="w-10 h-10 rounded-xl bg-blue-100 flex items-center justify-center">
                      <FontAwesomeIcon
                        icon={faChartBar}
                        className="text-2xl text-blue-600"
                      />
                    </div>
                    <p className="text-gray-500 font-semibold">Total Tickets</p>
                  </div>
                  <h3 className="text-4xl font-extrabold text-primary">
                    {tickets.length}
                  </h3>
                </div>
              </div>

              {/* CONTROL BUTTONS */}
              <div className="bg-white rounded-3xl p-6 md:p-8 shadow-xl border border-primary/20">
                <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
                  <button
                    onClick={() => {
                      window.speechSynthesis.cancel(); // reset
                      window.speechSynthesis.resume(); // unlock audio
                      callNext();
                    }}
                    className="px-6 py-5 bg-linear-to-r from-primary via-orange-600 to-primary text-white rounded-2xl text-base md:text-lg font-bold shadow-lg hover:shadow-xl hover:scale-105 transition-all"
                  >
                    ▶ Next
                  </button>

                  <button
                    onClick={skipCurrent}
                    className="px-6 py-5 bg-linear-to-r from-red-500 to-red-600 text-white rounded-2xl text-base md:text-lg font-bold shadow-lg hover:shadow-xl hover:scale-105 transition-all"
                  >
                    ⏭ Skip
                  </button>

                  <button
                    onClick={cancelCurrent}
                    className="px-6 py-5 bg-linear-to-r from-red-700 to-red-800 text-white rounded-2xl text-base md:text-lg font-bold shadow-lg hover:shadow-xl hover:scale-105 transition-all"
                  >
                    ✕ Cancel
                  </button>

                  <button
                    onClick={() => {
                      if (queue?.latest_number !== null) {
                        speakNumber(queue.latest_number);
                      }
                    }}
                    className="px-6 py-5 bg-linear-to-r from-gray-600 to-gray-700 text-white rounded-2xl text-base md:text-lg font-bold shadow-lg hover:shadow-xl hover:scale-105 transition-all"
                  >
                    <FontAwesomeIcon icon={faVolumeUp} className="mr-2" />{" "}
                    Announce
                  </button>
                  <button
                    onClick={() =>
                      window.open(
                        `/admin/queue/${queue.id}/qr`,
                        "qrWindow",
                        "width=1200,height=800,left=200,top=100,resizable=yes,scrollbars=yes",
                      )
                    }
                    className="px-6 py-5 bg-linear-to-r from-primary to-orange-700 text-white rounded-2xl text-base md:text-lg font-bold shadow-lg hover:shadow-xl hover:scale-105 transition-all"
                  >
                    <FontAwesomeIcon icon={faMobileAlt} className="mr-2" /> Show
                    QR
                  </button>
                  <button
                    onClick={handleCutoffClick}
                    className="px-6 py-5 bg-linear-to-r from-purple-600 to-indigo-700 text-white rounded-2xl text-base md:text-lg font-bold shadow-lg hover:shadow-xl hover:scale-105 transition-all"
                  >
                    ✂ Cutoff
                  </button>
                </div>

                {/* Auto-Advance Timer Control */}
                <div className="mt-6 pt-6 border-t border-gray-200">
                  <div className="flex items-center justify-between gap-4">
                    <div className="flex-1">
                      <p className="text-sm font-semibold text-gray-600 mb-2">
                        Auto-Advance Timer
                      </p>
                      {autoAdvanceTimer ? (
                        <div className="flex items-center gap-3">
                          <div className="flex-1 h-3 bg-gray-200 rounded-full overflow-hidden">
                            <div
                              className="h-full bg-linear-to-r from-orange-500 to-red-500 transition-all duration-1000 ease-linear"
                              style={{ width: `${(countdown / 5) * 100}%` }}
                            />
                          </div>
                          <span className="text-2xl font-bold text-orange-600 w-12 text-center">
                            {countdown}
                          </span>
                        </div>
                      ) : (
                        <p className="text-sm text-gray-500">
                          Start timer to auto-advance queue after 5 seconds
                        </p>
                      )}
                    </div>
                    {autoAdvanceTimer ? (
                      <button
                        onClick={cancelAutoAdvance}
                        className="px-6 py-3 bg-yellow-500 hover:bg-yellow-600 text-white rounded-xl text-sm font-bold shadow-md hover:shadow-lg transition-all whitespace-nowrap"
                      >
                        ✖ Cancel
                      </button>
                    ) : (
                      <button
                        onClick={startAutoAdvance}
                        disabled={processing || !currentServing}
                        className={`px-6 py-3 rounded-xl text-sm font-bold shadow-md hover:shadow-lg transition-all whitespace-nowrap ${
                          processing || !currentServing
                            ? "bg-gray-300 cursor-not-allowed text-gray-500"
                            : "bg-linear-to-r from-green-500 to-emerald-600 text-white hover:scale-105"
                        }`}
                      >
                        ⏱ Start 5s Timer
                      </button>
                    )}
                  </div>
                </div>

                {/* Cutoff Status Display */}
                {queue?.cutoff_number !== null &&
                  queue?.cutoff_number !== undefined &&
                  queue.cutoff_number > 0 && (
                    <div className="mt-6 pt-6 border-t border-purple-200">
                      <div className="flex items-center justify-between gap-4">
                        <div className="flex-1">
                          <p className="text-sm font-semibold text-purple-700 mb-2 flex items-center gap-2">
                            <span className="text-lg">✂</span> End-of-Day Cutoff
                            Active
                          </p>
                          <p className="text-sm text-gray-600">
                            Serving for{" "}
                            <span className="font-bold text-purple-800">
                              {queue.cutoff_number} more ticket
                              {queue.cutoff_number !== 1 ? "s" : ""}
                            </span>{" "}
                            today
                          </p>
                          {queue.latest_number && (
                            <p className="text-xs text-gray-500 mt-1">
                              Current: #{queue.latest_number} • Will end at: #
                              {queue.latest_number + queue.cutoff_number} •
                              Remaining tickets continue tomorrow
                            </p>
                          )}
                        </div>
                        <button
                          onClick={handleRemoveCutoff}
                          className="px-4 py-2 bg-red-500 hover:bg-red-600 text-white rounded-xl text-sm font-bold shadow-md hover:shadow-lg transition-all"
                        >
                          Remove
                        </button>
                      </div>
                    </div>
                  )}
              </div>

              {/* Cutoff Modal */}
              {showCutoffModal && (
                <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50 p-4">
                  <div className="bg-white rounded-3xl shadow-2xl max-w-md w-full p-8 border-2 border-purple-200">
                    <h3 className="text-2xl font-bold text-gray-900 mb-2 text-center">
                      Set End-of-Day Cutoff
                    </h3>
                    <p className="text-gray-600 text-center mb-4">
                      Current ticket:{" "}
                      <span className="font-bold text-primary">
                        #{queue?.latest_number || 0}
                      </span>
                    </p>
                    <p className="text-sm text-purple-700 bg-purple-50 p-3 rounded-xl mb-6 text-center">
                      💡 Enter the number of tickets to serve today. Remaining
                      tickets will continue tomorrow or next working day.
                    </p>

                    <div className="space-y-3 mb-6">
                      <p className="text-sm font-semibold text-gray-700 mb-2">
                        Quick Select (Number of Tickets to Serve):
                      </p>
                      {[1, 2, 3, 4].map((increment) => (
                        <button
                          key={increment}
                          onClick={() => handleCutoffIncrementSelect(increment)}
                          className="w-full px-6 py-4 bg-linear-to-r from-purple-500 to-indigo-600 hover:from-purple-600 hover:to-indigo-700 text-white rounded-2xl text-lg font-bold shadow-lg hover:shadow-xl hover:scale-105 transition-all flex items-center justify-between"
                        >
                          <span>
                            Serve {increment} More Ticket
                            {increment > 1 ? "s" : ""}
                          </span>
                          <span className="text-sm opacity-90">
                            Until #{(queue?.latest_number || 0) + increment}
                          </span>
                        </button>
                      ))}
                    </div>

                    <div className="mb-6">
                      <p className="text-sm font-semibold text-gray-700 mb-2">
                        Or Enter Custom Ending Ticket Number:
                      </p>
                      <div className="flex gap-2">
                        <input
                          type="number"
                          value={customCutoffValue}
                          onChange={(e) => setCustomCutoffValue(e.target.value)}
                          placeholder={`Enter ending ticket # (min: ${(queue?.latest_number || 0) + 1})`}
                          min={(queue?.latest_number || 0) + 1}
                          className="flex-1 px-4 py-3 border-2 border-gray-300 rounded-xl focus:border-purple-500 focus:ring-2 focus:ring-purple-200 outline-none transition font-semibold"
                        />
                        <button
                          onClick={() => {
                            const customNum = parseInt(customCutoffValue);
                            if (
                              !isNaN(customNum) &&
                              customNum > (queue?.latest_number || 0)
                            ) {
                              handleSetCustomCutoff(customNum);
                            }
                          }}
                          disabled={
                            !customCutoffValue ||
                            parseInt(customCutoffValue) <=
                              (queue?.latest_number || 0)
                          }
                          className="px-6 py-3 bg-linear-to-r from-purple-600 to-indigo-700 hover:from-purple-700 hover:to-indigo-800 text-white rounded-xl font-bold shadow-lg hover:shadow-xl transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          Set Cutoff
                        </button>
                      </div>
                    </div>

                    <button
                      onClick={() => setShowCutoffModal(false)}
                      className="w-full px-6 py-3 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-xl font-semibold transition-all"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}

              {/* WAITING LIST */}
              <div className="bg-white rounded-3xl shadow-xl p-6 md:p-8 border border-primary/20">
                <div className="flex items-center gap-3 mb-6">
                  <div className="w-12 h-12 rounded-xl bg-linear-to-br from-primary/10 to-primary/20 flex items-center justify-center">
                    <FontAwesomeIcon
                      icon={faList}
                      className="text-2xl text-primary"
                    />
                  </div>
                  <h3 className="text-2xl font-bold text-gray-900">
                    Ticket List
                  </h3>
                </div>

                <div className="space-y-3 max-h-96 overflow-y-auto pr-2 custom-scrollbar">
                  {tickets
                    .slice()
                    .sort((a, b) => {
                      const order: Record<TicketStatus, number> = {
                        waiting: 0,
                        serving: 1,
                        done: 2,
                        skipped: 3,
                        cancelled: 4,
                      };
                      return order[a.status] - order[b.status];
                    })
                    .map((ticket) => {
                      const statusClasses = {
                        waiting:
                          "bg-linear-to-r from-yellow-50 to-orange-50 border-yellow-200 text-yellow-900",
                        serving:
                          "bg-linear-to-r from-green-50 to-emerald-50 border-green-200 text-green-900",
                        done: "bg-linear-to-r from-blue-50 to-cyan-50 border-blue-200 text-blue-900",
                        skipped:
                          "bg-linear-to-r from-red-50 to-pink-50 border-red-200 text-red-900",
                        cancelled:
                          "bg-linear-to-r from-red-50 to-pink-50 border-red-200 text-red-900",
                      };

                      return (
                        <div
                          key={ticket.id}
                          className={`flex justify-between rounded-xl p-4 border-2 ${statusClasses[ticket.status as keyof typeof statusClasses] ?? "bg-gray-50 border-gray-200 text-gray-800"} hover:shadow-md transition-all`}
                        >
                          <div className="flex items-center gap-3">
                            <span className="text-lg font-bold">
                              #{ticket.ticket_number}
                            </span>
                            <span className="font-medium">
                              {ticket.client_name}
                            </span>
                          </div>
                          <span className="px-3 py-1 rounded-full text-xs font-bold uppercase tracking-wide bg-white/60 shadow-sm">
                            {ticket.status}
                          </span>
                        </div>
                      );
                    })}
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </Layout>
  );
};

export default ManageQueue;

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./Dashboard.css";
import Icon from "./Icon";
import { whenPlaybackIdle } from "../streamClient";

const STREAM_ENDPOINT = "/api/stream";
const streamUrl = (token) => `${STREAM_ENDPOINT}?token=${encodeURIComponent(token)}`;

const fmt = (s) => {
  if (!Number.isFinite(s) || s < 0) return "0:00";
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
};

/* ------------------------------------------------------------------ *
 * Audio engine: a pool of two <audio> elements.
 *  - hover/focus "warms" the standby element (src + load()) so the CDN
 *    handshake and first chunks are already in flight before the click;
 *  - a click swaps to the warmed element, or maps src, calls load() and
 *    play() synchronously inside the user gesture if it wasn't warmed;
 *  - alternating elements avoids aborting a pending load on the one that
 *    is still audible.
 * ------------------------------------------------------------------ */
function useAudioEngine() {
  const pool = useRef([]);
  const active = useRef(0);
  const warmTimer = useRef(null);
  const [state, setState] = useState({
    item: null, playing: false, buffering: false, time: 0, duration: 0, error: false,
  });

  useEffect(() => {
    const els = [new Audio(), new Audio()];
    els.forEach((a) => {
      a.preload = "auto";
      a.dataset.token = "";
    });
    pool.current = els;

    const patchIfActive = (patch) => (e) => {
      if (e.target === pool.current[active.current]) setState((s) => ({ ...s, ...patch(e.target) }));
    };

    const handlers = {
      play: patchIfActive(() => ({ playing: true, error: false })),
      playing: patchIfActive(() => ({ playing: true, buffering: false })),
      pause: patchIfActive(() => ({ playing: false })),
      waiting: patchIfActive(() => ({ buffering: true })),
      canplay: patchIfActive(() => ({ buffering: false })),
      timeupdate: patchIfActive((a) => ({ time: a.currentTime })),
      durationchange: patchIfActive((a) => ({ duration: a.duration })),
      ended: patchIfActive(() => ({ playing: false, time: 0 })),
      error: patchIfActive((a) => (a.dataset.token ? { error: true, playing: false, buffering: false } : {})),
    };
    els.forEach((a) => Object.entries(handlers).forEach(([ev, fn]) => a.addEventListener(ev, fn)));

    return () => {
      clearTimeout(warmTimer.current);
      els.forEach((a) => {
        Object.entries(handlers).forEach(([ev, fn]) => a.removeEventListener(ev, fn));
        a.pause();
        a.removeAttribute("src");
        a.load();
      });
    };
  }, []);

  const standby = () => pool.current[1 - active.current];

  const prime = (el, token) => {
    if (el.dataset.token === token) return;
    el.dataset.token = token;
    el.src = streamUrl(token);
    el.load(); // opens the network socket right away (preload="auto")
  };

  const warm = useCallback((item) => {
    clearTimeout(warmTimer.current);
    warmTimer.current = setTimeout(() => {
      const el = standby();
      if (el && el.paused) prime(el, item.id);
    }, 80); // ignore drive-by cursor movement
  }, []);

  const cancelWarm = useCallback(() => clearTimeout(warmTimer.current), []);

  const play = useCallback((item) => {
    const prev = pool.current[active.current];
    const next = standby();
    if (!next) return;

    prev.pause();
    active.current = 1 - active.current;
    prime(next, item.id);

    setState({ item, playing: false, buffering: true, time: 0, duration: 0, error: false });
    next.currentTime = 0;
    // Called synchronously inside the click handler => allowed by autoplay policy.
    next.play().catch((err) => {
      if (err?.name === "AbortError") return; // superseded by a newer click
      setState((s) => ({ ...s, playing: false, buffering: false, error: true }));
    });
  }, []);

  const toggle = useCallback((item) => {
    const el = pool.current[active.current];
    if (el && el.dataset.token === item.id) {
      if (el.paused) el.play().catch(() => setState((s) => ({ ...s, error: true })));
      else el.pause();
    } else {
      play(item);
    }
  }, [play]);

  const seek = useCallback((t) => {
    const el = pool.current[active.current];
    if (el && Number.isFinite(t)) el.currentTime = t;
  }, []);

  return { ...state, warm, cancelWarm, toggle, seek };
}

/* ------------------------------------------------------------------ *
 * Piped API client (Recommended mode only)
 *  - tries each public instance in order and remembers the last one that
 *    worked, so a dead instance costs one timeout, not one per request;
 *  - override the list with VITE_PIPED_API_INSTANCES="https://a,https://b".
 *    NOTE: "kavin.rocks" is the Piped *frontend*; its API host is
 *    pipedapi.kavin.rocks.
 * ------------------------------------------------------------------ */
const DEFAULT_PIPED_INSTANCES = [
  "https://pipedapi.kavin.rocks",
  "https://pipedapi.adminforge.de",
  "https://api.piped.private.coffee",
  "https://pipedapi.leptons.xyz",
  "https://piped-api.garudalinux.org",
];
const PIPED_INSTANCES = (import.meta.env?.VITE_PIPED_API_INSTANCES || "")
  .split(",").map((u) => u.trim().replace(/\/+$/, "")).filter(Boolean);
const INSTANCES = PIPED_INSTANCES.length ? PIPED_INSTANCES : DEFAULT_PIPED_INSTANCES;

// Every "shelf" in Recommended mode is one fresh search for one of these.
// Order and query wording are randomised per visit, so each refresh differs.
const SECTION_SEEDS = [
  { title: "Bollywood Hits", q: "bollywood hits" },
  { title: "Arijit Singh", q: "arijit singh" },
  { title: "Kishore Kumar", q: "kishore kumar" },
  { title: "Mohammed Rafi", q: "mohammed rafi" },
  { title: "Lata Mangeshkar", q: "lata mangeshkar" },
  { title: "Ghazal Nights", q: "ghazal jagjit singh" },
  { title: "Sufi Soul", q: "sufi songs" },
  { title: "90s Romance", q: "90s bollywood romantic" },
  { title: "Old Hindi Classics", q: "old hindi classics" },
  { title: "Hindi Lofi", q: "hindi lofi" },
  { title: "Atif Aslam", q: "atif aslam" },
  { title: "Shreya Ghoshal", q: "shreya ghoshal" },
  { title: "Sonu Nigam", q: "sonu nigam" },
  { title: "Udit Narayan", q: "udit narayan" },
  { title: "Kumar Sanu", q: "kumar sanu" },
  { title: "Alka Yagnik", q: "alka yagnik" },
  { title: "Jubin Nautiyal", q: "jubin nautiyal" },
  { title: "A. R. Rahman", q: "ar rahman" },
  { title: "Pritam Specials", q: "pritam songs" },
  { title: "Nusrat Fateh Ali Khan", q: "nusrat fateh ali khan" },
  { title: "Rahat Fateh Ali Khan", q: "rahat fateh ali khan" },
  { title: "Lucky Ali", q: "lucky ali" },
  { title: "KK Forever", q: "kk songs" },
  { title: "Mohit Chauhan", q: "mohit chauhan" },
  { title: "Punjabi Hits", q: "punjabi hit songs" },
  { title: "Heartbreak", q: "hindi sad songs" },
  { title: "Road Trip", q: "hindi road trip songs" },
  { title: "Party Mode", q: "bollywood party songs" },
  { title: "Wedding Season", q: "bollywood wedding songs" },
  { title: "Monsoon Mood", q: "hindi rain songs" },
  { title: "Late Night", q: "hindi late night songs" },
  { title: "Retro 70s", q: "70s bollywood songs" },
  { title: "Retro 80s", q: "80s bollywood songs" },
  { title: "Evergreen Duets", q: "bollywood duets" },
  { title: "Bhajan & Devotional", q: "bhajan" },
  { title: "Qawwali", q: "qawwali" },
  { title: "Indie India", q: "indian indie songs" },
  { title: "Acoustic Hindi", q: "hindi acoustic songs" },
  { title: "Workout Beats", q: "bollywood workout songs" },
  { title: "Love Songs", q: "hindi love songs" },
];
// Mood chips on the Recommended page. "all" keeps the original mixed feed;
// every other mood only draws shelves from its own seed list.
const MOODS = [
  { id: "all", label: "All", icon: "sparkles" },
  { id: "romantic", label: "Romantic", icon: "heart" },
  { id: "party", label: "Party", icon: "party" },
  { id: "sad", label: "Sad", icon: "heartCrack" },
  { id: "retro90", label: "Retro 90s", icon: "tape" },
  { id: "workout", label: "Workout", icon: "dumbbell" },
  // Era timeline (purane zamane ki sair): one tap and the shelves fill with songs of that decade.
  { id: "era50", label: "50s", icon: "tape" },
  { id: "era60", label: "60s", icon: "tape" },
  { id: "era70", label: "70s", icon: "tape" },
  { id: "era80", label: "80s", icon: "tape" },
  { id: "era90", label: "90s", icon: "tape" },
  { id: "era00", label: "2000s", icon: "tape" },
];
const MOOD_SEEDS = {
  romantic: [
    { title: "Love Songs", q: "hindi love songs" },
    { title: "Romantic Hits", q: "bollywood romantic songs" },
    { title: "Arijit Singh Romance", q: "arijit singh romantic" },
    { title: "Jubin Nautiyal Love", q: "jubin nautiyal romantic" },
    { title: "Shreya Ghoshal Melodies", q: "shreya ghoshal romantic" },
    { title: "Evergreen Duets", q: "bollywood duets" },
    { title: "Atif Aslam Love", q: "atif aslam romantic" },
    { title: "Rahat Fateh Ali Khan", q: "rahat fateh ali khan romantic" },
    { title: "Nusrat Fateh Ali Khan Love", q: "nusrat fateh ali khan love songs" },
    { title: "Armaan Malik Romance", q: "armaan malik romantic" },
    { title: "Darshan Raval Love", q: "darshan raval romantic" },
    { title: "B Praak Love", q: "b praak romantic" },
    { title: "Sonu Nigam Melodies", q: "sonu nigam romantic" },
    { title: "Mohit Chauhan Soul", q: "mohit chauhan romantic" },
    { title: "Papon Magic", q: "papon love songs" },
    { title: "Neha Kakkar Love", q: "neha kakkar romantic" },
    { title: "Palak Muchhal Love", q: "palak muchhal romantic" },
    { title: "Kumar Sanu Romance", q: "kumar sanu romantic" },
    { title: "Lata & Kishore Classics", q: "lata mangeshkar kishore kumar duets" },
    { title: "Mohammed Rafi Romance", q: "mohammed rafi romantic" },
    { title: "Shaan Love", q: "shaan romantic songs" },
    { title: "Sufi Romance", q: "sufi love songs" },
    { title: "Punjabi Love", q: "punjabi romantic songs" },
    { title: "Ghazal Love", q: "romantic ghazal" },
  ],
  party: [
    { title: "Party Mode", q: "bollywood party songs" },
    { title: "Dance Floor", q: "bollywood dance songs" },
    { title: "Punjabi Party", q: "punjabi party songs" },
    { title: "Wedding Season", q: "bollywood wedding songs" },
    { title: "Badshah Party", q: "badshah party" },
    { title: "Honey Singh Party", q: "yo yo honey singh party" },
    { title: "Diljit Dosanjh", q: "diljit dosanjh party" },
    { title: "Guru Randhawa", q: "guru randhawa party" },
    { title: "AP Dhillon", q: "ap dhillon" },
    { title: "Karan Aujla", q: "karan aujla" },
    { title: "Mika Singh", q: "mika singh party" },
    { title: "Neha Kakkar Party", q: "neha kakkar party songs" },
    { title: "Sunidhi Chauhan Beats", q: "sunidhi chauhan dance" },
    { title: "Raftaar & Divine", q: "raftaar divine hindi rap" },
    { title: "Club Anthems", q: "hindi club songs" },
    { title: "Remix Hits", q: "bollywood remix party" },
    { title: "Sangeet Night", q: "sangeet dance songs" },
    { title: "Dhol Beats", q: "bhangra dhol songs" },
    { title: "Item Numbers", q: "bollywood item songs" },
    { title: "Road Trip", q: "hindi road trip songs" },
  ],
  sad: [
    { title: "Heartbreak", q: "hindi sad songs" },
    { title: "Arijit Singh Sad", q: "arijit singh sad songs" },
    { title: "Broken Heart Ghazals", q: "sad ghazal" },
    { title: "Late Night Pain", q: "hindi late night sad songs" },
    { title: "KK Emotional", q: "kk sad songs" },
    { title: "Sad Retro", q: "old hindi sad songs" },
    { title: "Rahat Fateh Ali Khan Sad", q: "rahat fateh ali khan sad songs" },
    { title: "Nusrat Fateh Ali Khan Qawwali", q: "nusrat fateh ali khan sad" },
    { title: "Atif Aslam Sad", q: "atif aslam sad songs" },
    { title: "Jubin Nautiyal Sad", q: "jubin nautiyal sad songs" },
    { title: "Mohit Chauhan Sad", q: "mohit chauhan sad songs" },
    { title: "Sonu Nigam Sad", q: "sonu nigam sad songs" },
    { title: "B Praak Sad", q: "b praak sad songs" },
    { title: "Ankit Tiwari Sad", q: "ankit tiwari sad songs" },
    { title: "Armaan Malik Sad", q: "armaan malik sad songs" },
    { title: "Jagjit Singh Ghazals", q: "jagjit singh sad ghazal" },
    { title: "Mohammed Rafi Dard", q: "mohammed rafi sad songs" },
    { title: "Mukesh Dard Bhare", q: "mukesh sad songs" },
    { title: "Lucky Ali Soul", q: "lucky ali sad songs" },
    { title: "Bewafa Songs", q: "bewafa songs hindi" },
    { title: "Judaai", q: "judaai hindi songs" },
    { title: "Punjabi Sad", q: "punjabi sad songs" },
    { title: "Lofi Sad", q: "hindi sad lofi" },
  ],
  retro90: [
    { title: "90s Romance", q: "90s bollywood romantic" },
    { title: "Kumar Sanu 90s", q: "kumar sanu 90s" },
    { title: "Udit Narayan 90s", q: "udit narayan 90s" },
    { title: "Alka Yagnik 90s", q: "alka yagnik 90s" },
    { title: "90s Bollywood Hits", q: "90s bollywood hits" },
    { title: "90s Dance", q: "90s bollywood dance songs" },
    { title: "Sonu Nigam 90s", q: "sonu nigam 90s" },
    { title: "Abhijeet 90s", q: "abhijeet bhattacharya 90s" },
    { title: "Kavita Krishnamurthy", q: "kavita krishnamurthy 90s" },
    { title: "Sadhana Sargam", q: "sadhana sargam 90s" },
    { title: "Anuradha Paudwal", q: "anuradha paudwal 90s" },
    { title: "Jatin Lalit Hits", q: "jatin lalit 90s" },
    { title: "Nadeem Shravan Hits", q: "nadeem shravan 90s" },
    { title: "A R Rahman 90s", q: "ar rahman 90s hindi" },
    { title: "Shah Rukh 90s", q: "shah rukh khan 90s songs" },
    { title: "Govinda Hits", q: "govinda 90s songs" },
    { title: "Aamir Khan 90s", q: "aamir khan 90s songs" },
    { title: "Sad 90s", q: "90s bollywood sad songs" },
  ],
  workout: [
    { title: "Workout Beats", q: "bollywood workout songs" },
    { title: "Gym Motivation", q: "hindi gym motivation songs" },
    { title: "High Energy", q: "bollywood high energy songs" },
    { title: "Running Playlist", q: "hindi running songs" },
    { title: "Pump Up", q: "bollywood pump up songs" },
    { title: "Sports Anthems", q: "bollywood sports songs" },
    { title: "Divine Hustle", q: "divine hindi rap" },
    { title: "Raftaar Rap", q: "raftaar rap songs" },
    { title: "Emiway Bantai", q: "emiway bantai" },
    { title: "Badshah Energy", q: "badshah high energy" },
    { title: "Diljit Power", q: "diljit dosanjh energy" },
    { title: "Sukhwinder Singh", q: "sukhwinder singh energetic" },
    { title: "Farhan Akhtar Motivation", q: "farhan akhtar motivational songs" },
    { title: "Sidhu Moose Wala", q: "sidhu moose wala" },
    { title: "Motivational Hindi", q: "hindi motivational songs" },
    { title: "Deshbhakti Josh", q: "deshbhakti josh songs" },
  ],
  // ----- era timeline seeds -----
  era50: [
    { title: "50s Bollywood Hits", q: "1950s bollywood hit songs" },
    { title: "50s Romantic", q: "1950s bollywood romantic songs" },
    { title: "50s Evergreen", q: "1950s hindi evergreen songs" },
    { title: "50s Dance", q: "1950s bollywood dance songs" },
    { title: "50s Sad Songs", q: "1950s hindi sad songs" },
    { title: "50s Duets", q: "1950s bollywood duets" },
    { title: "50s Film Classics", q: "1950s hindi film songs" },
    { title: "Lata Mangeshkar 50s", q: "Lata Mangeshkar 1950s hindi songs" },
    { title: "Mohammed Rafi 50s", q: "Mohammed Rafi 1950s hindi songs" },
    { title: "Talat Mahmood 50s", q: "Talat Mahmood 1950s hindi songs" },
    { title: "Geeta Dutt 50s", q: "Geeta Dutt 1950s hindi songs" },
    { title: "Mukesh 50s", q: "Mukesh 1950s hindi songs" },
    { title: "Hemant Kumar 50s", q: "Hemant Kumar 1950s hindi songs" },
    { title: "Manna Dey 50s", q: "Manna Dey 1950s hindi songs" },
    { title: "Shamshad Begum 50s", q: "Shamshad Begum 1950s hindi songs" },
    { title: "Asha Bhosle 50s", q: "Asha Bhosle 1950s hindi songs" },
    { title: "Kishore Kumar 50s", q: "Kishore Kumar 1950s hindi songs" },
  ],
  era60: [
    { title: "60s Bollywood Hits", q: "1960s bollywood hit songs" },
    { title: "60s Romantic", q: "1960s bollywood romantic songs" },
    { title: "60s Evergreen", q: "1960s hindi evergreen songs" },
    { title: "60s Dance", q: "1960s bollywood dance songs" },
    { title: "60s Sad Songs", q: "1960s hindi sad songs" },
    { title: "60s Duets", q: "1960s bollywood duets" },
    { title: "60s Film Classics", q: "1960s hindi film songs" },
    { title: "Mohammed Rafi 60s", q: "Mohammed Rafi 1960s hindi songs" },
    { title: "Lata Mangeshkar 60s", q: "Lata Mangeshkar 1960s hindi songs" },
    { title: "Kishore Kumar 60s", q: "Kishore Kumar 1960s hindi songs" },
    { title: "Asha Bhosle 60s", q: "Asha Bhosle 1960s hindi songs" },
    { title: "Mukesh 60s", q: "Mukesh 1960s hindi songs" },
    { title: "Mahendra Kapoor 60s", q: "Mahendra Kapoor 1960s hindi songs" },
    { title: "Manna Dey 60s", q: "Manna Dey 1960s hindi songs" },
    { title: "Talat Mahmood 60s", q: "Talat Mahmood 1960s hindi songs" },
    { title: "Hemant Kumar 60s", q: "Hemant Kumar 1960s hindi songs" },
    { title: "Suman Kalyanpur 60s", q: "Suman Kalyanpur 1960s hindi songs" },
  ],
  era70: [
    { title: "70s Bollywood Hits", q: "1970s bollywood hit songs" },
    { title: "70s Romantic", q: "1970s bollywood romantic songs" },
    { title: "70s Evergreen", q: "1970s hindi evergreen songs" },
    { title: "70s Dance", q: "1970s bollywood dance songs" },
    { title: "70s Sad Songs", q: "1970s hindi sad songs" },
    { title: "70s Duets", q: "1970s bollywood duets" },
    { title: "70s Film Classics", q: "1970s hindi film songs" },
    { title: "Kishore Kumar 70s", q: "Kishore Kumar 1970s hindi songs" },
    { title: "Lata Mangeshkar 70s", q: "Lata Mangeshkar 1970s hindi songs" },
    { title: "R D Burman 70s", q: "R D Burman 1970s hindi songs" },
    { title: "Asha Bhosle 70s", q: "Asha Bhosle 1970s hindi songs" },
    { title: "Mohammed Rafi 70s", q: "Mohammed Rafi 1970s hindi songs" },
    { title: "Mukesh 70s", q: "Mukesh 1970s hindi songs" },
    { title: "Kalyanji Anandji 70s", q: "Kalyanji Anandji 1970s hindi songs" },
    { title: "Laxmikant Pyarelal 70s", q: "Laxmikant Pyarelal 1970s hindi songs" },
    { title: "Manna Dey 70s", q: "Manna Dey 1970s hindi songs" },
    { title: "Amit Kumar 70s", q: "Amit Kumar 1970s hindi songs" },
  ],
  era80: [
    { title: "80s Bollywood Hits", q: "1980s bollywood hit songs" },
    { title: "80s Romantic", q: "1980s bollywood romantic songs" },
    { title: "80s Evergreen", q: "1980s hindi evergreen songs" },
    { title: "80s Dance", q: "1980s bollywood dance songs" },
    { title: "80s Sad Songs", q: "1980s hindi sad songs" },
    { title: "80s Duets", q: "1980s bollywood duets" },
    { title: "80s Film Classics", q: "1980s hindi film songs" },
    { title: "Kishore Kumar 80s", q: "Kishore Kumar 1980s hindi songs" },
    { title: "Bappi Lahiri 80s", q: "Bappi Lahiri 1980s hindi songs" },
    { title: "Lata Mangeshkar 80s", q: "Lata Mangeshkar 1980s hindi songs" },
    { title: "Asha Bhosle 80s", q: "Asha Bhosle 1980s hindi songs" },
    { title: "Amit Kumar 80s", q: "Amit Kumar 1980s hindi songs" },
    { title: "Kavita Krishnamurthy 80s", q: "Kavita Krishnamurthy 1980s hindi songs" },
    { title: "Alisha Chinai 80s", q: "Alisha Chinai 1980s hindi songs" },
    { title: "Anuradha Paudwal 80s", q: "Anuradha Paudwal 1980s hindi songs" },
    { title: "Shailendra Singh 80s", q: "Shailendra Singh 1980s hindi songs" },
    { title: "Laxmikant Pyarelal 80s", q: "Laxmikant Pyarelal 1980s hindi songs" },
  ],
  era90: [
    { title: "90s Bollywood Hits", q: "1990s bollywood hit songs" },
    { title: "90s Romantic", q: "1990s bollywood romantic songs" },
    { title: "90s Evergreen", q: "1990s hindi evergreen songs" },
    { title: "90s Dance", q: "1990s bollywood dance songs" },
    { title: "90s Sad Songs", q: "1990s hindi sad songs" },
    { title: "90s Duets", q: "1990s bollywood duets" },
    { title: "90s Film Classics", q: "1990s hindi film songs" },
    { title: "Kumar Sanu 90s", q: "Kumar Sanu 1990s hindi songs" },
    { title: "Udit Narayan 90s", q: "Udit Narayan 1990s hindi songs" },
    { title: "Alka Yagnik 90s", q: "Alka Yagnik 1990s hindi songs" },
    { title: "Abhijeet 90s", q: "Abhijeet 1990s hindi songs" },
    { title: "Sadhana Sargam 90s", q: "Sadhana Sargam 1990s hindi songs" },
    { title: "Nadeem Shravan 90s", q: "Nadeem Shravan 1990s hindi songs" },
    { title: "Jatin Lalit 90s", q: "Jatin Lalit 1990s hindi songs" },
    { title: "Anu Malik 90s", q: "Anu Malik 1990s hindi songs" },
    { title: "Kavita Krishnamurthy 90s", q: "Kavita Krishnamurthy 1990s hindi songs" },
    { title: "Sonu Nigam 90s", q: "Sonu Nigam 1990s hindi songs" },
  ],
  era00: [
    { title: "2000s Bollywood Hits", q: "2000s bollywood hit songs" },
    { title: "2000s Romantic", q: "2000s bollywood romantic songs" },
    { title: "2000s Evergreen", q: "2000s hindi evergreen songs" },
    { title: "2000s Dance", q: "2000s bollywood dance songs" },
    { title: "2000s Sad Songs", q: "2000s hindi sad songs" },
    { title: "2000s Duets", q: "2000s bollywood duets" },
    { title: "2000s Film Classics", q: "2000s hindi film songs" },
    { title: "Sonu Nigam 2000s", q: "Sonu Nigam 2000s hindi songs" },
    { title: "Shreya Ghoshal 2000s", q: "Shreya Ghoshal 2000s hindi songs" },
    { title: "Sunidhi Chauhan 2000s", q: "Sunidhi Chauhan 2000s hindi songs" },
    { title: "Shaan 2000s", q: "Shaan 2000s hindi songs" },
    { title: "KK 2000s", q: "KK 2000s hindi songs" },
    { title: "Udit Narayan 2000s", q: "Udit Narayan 2000s hindi songs" },
    { title: "Himesh Reshammiya 2000s", q: "Himesh Reshammiya 2000s hindi songs" },
    { title: "Pritam 2000s", q: "Pritam 2000s hindi songs" },
    { title: "Vishal Shekhar 2000s", q: "Vishal Shekhar 2000s hindi songs" },
    { title: "A R Rahman 2000s", q: "A R Rahman 2000s hindi songs" },
  ],
};
const QUERY_SUFFIXES = ["", " songs", " best", " hits", " evergreen", " top"];
const SECTION_SIZE = 12;   // cards per shelf
const MIN_NEW_PER_SECTION = 4;
const MAX_CONSECUTIVE_FAILS = 3;
const MAX_DRY_SECTIONS = 10; // shelves in a row with nothing new => stop
const PIPED_FILTER = "music_songs";
const REQUEST_TIMEOUT_MS = 6000;

let preferredInstance = 0;

async function pipedGet(path, params, signal) {
  await whenPlaybackIdle(6000); // never compete with a song the listener just clicked
  const qs = new URLSearchParams(params).toString();
  let lastErr = new Error("No Piped instance reachable");
  for (let n = 0; n < INSTANCES.length; n++) {
    const idx = (preferredInstance + n) % INSTANCES.length;
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort();
    signal?.addEventListener("abort", onAbort);
    const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(`${INSTANCES[idx]}${path}?${qs}`, { signal: ctrl.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      preferredInstance = idx;
      return data;
    } catch (err) {
      if (signal?.aborted) throw err; // caller cancelled — don't fail over
      lastErr = err;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }
  throw lastErr;
}

// Google-hosted covers end in "=w60-h60-..." / "=s120"; ask for 544px instead.
const hiRes = (url) =>
  typeof url === "string"
    ? url.replace(/=w\d+-h\d+[^/?]*$/, "=w544-h544-l90-rj").replace(/=s\d+[^/?]*$/, "=s544")
    : null;

const toTrack = (it) => {
  const id = /[?&]v=([\w-]{11})/.exec(it?.url || "")?.[1];
  if (!id || it.type !== "stream") return null;
  return {
    id,
    title: it.title || "Untitled",
    subtitle: (it.uploaderName || "Unknown artist").replace(/\s*-\s*Topic$/i, ""),
    channel: (it.uploaderName || "").replace(/\s*-\s*Topic$/i, ""), // field name Player/search use
    duration: it.duration > 0 ? fmt(it.duration) : null,
    durationSeconds: it.duration > 0 ? it.duration : null,
    thumbnailUrl: hiRes(it.thumbnail),
  };
};

/** Infinite scroll: fires `onNearBottom` when the window is within `offset`px of the end. */
function useNearBottom(onNearBottom, enabled, recheckKey, offset = 800) {
  const cb = useRef(onNearBottom);
  cb.current = onNearBottom;
  useEffect(() => {
    if (!enabled) return undefined;
    let raf = 0;
    const check = () => {
      raf = 0;
      const { scrollHeight } = document.documentElement;
      if (window.innerHeight + window.scrollY >= scrollHeight - offset) cb.current();
    };
    const onScroll = () => { if (!raf) raf = requestAnimationFrame(check); };
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll, { passive: true });
    onScroll(); // short first page that doesn't fill the viewport still triggers
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      cancelAnimationFrame(raf);
    };
  }, [enabled, offset, recheckKey]);
}

const shuffle = (arr) => {
  const r = arr.slice();
  for (let i = r.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [r[i], r[j]] = [r[j], r[i]];
  }
  return r;
};

/**
 * Endless feed of "shelves". Each shelf = one fresh Piped search (no `nextpage`
 * tokens — those only work on the instance that issued them, which broke
 * pagination whenever failover switched instances). Failed or unproductive
 * searches are skipped silently; an error shows only after repeated failures.
 */
function usePipedFeed(mood = "all") {
  const [sections, setSections] = useState([]);
  const [status, setStatus] = useState("idle"); // idle | loading | error | end
  const seen = useRef(new Set());
  const queue = useRef([]);
  const busy = useRef(false);
  const fails = useRef(0);
  const dry = useRef(0);
  const ctrlRef = useRef(null);
  const sectionNo = useRef(0);
  const genRef = useRef(0);      // bumps on every mood change so stale loads are ignored
  const moodRef = useRef(mood);
  moodRef.current = mood;

  const nextSeed = () => {
    if (!queue.current.length) {
      queue.current = shuffle(moodRef.current === "all" ? SECTION_SEEDS : (MOOD_SEEDS[moodRef.current] || SECTION_SEEDS));
    }
    return queue.current.pop();
  };

  // Switching mood: drop everything from the previous mood and start fresh.
  const firstRun = useRef(true);
  useEffect(() => {
    if (firstRun.current) { firstRun.current = false; return; }
    genRef.current += 1;
    ctrlRef.current?.abort();
    busy.current = false;
    seen.current = new Set();
    queue.current = [];
    fails.current = 0;
    dry.current = 0;
    sectionNo.current = 0;
    setSections([]);
    setStatus("idle");
  }, [mood]);

  const loadMore = useCallback(async () => {
    if (busy.current || status === "end") return;
    busy.current = true;
    const gen = genRef.current;
    setStatus("loading");
    const ctrl = new AbortController();
    ctrlRef.current = ctrl;
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        const seed = nextSeed();
        const suffix = QUERY_SUFFIXES[Math.floor(Math.random() * QUERY_SUFFIXES.length)];
        let data;
        try {
          data = await pipedGet("/search", { q: seed.q + suffix, filter: PIPED_FILTER }, ctrl.signal);
          fails.current = 0;
        } catch (err) {
          if (ctrl.signal.aborted || gen !== genRef.current) throw err;
          fails.current += 1;
          if (fails.current >= MAX_CONSECUTIVE_FAILS) throw err;
          continue; // silently try another search
        }

        if (gen !== genRef.current) return; // mood changed while this was loading
        const fresh = [];
        for (const raw of data?.items || []) {
          const t = toTrack(raw);
          if (t && !seen.current.has(t.id)) fresh.push(t);
        }
        if (fresh.length >= MIN_NEW_PER_SECTION) {
          const picked = shuffle(fresh).slice(0, SECTION_SIZE);
          picked.forEach((t) => seen.current.add(t.id));
          dry.current = 0;
          sectionNo.current += 1;
          setSections((prev) => prev.concat({ key: `s${sectionNo.current}`, title: seed.title, items: picked }));
          setStatus("idle");
          return;
        }
        dry.current += 1;
        if (dry.current >= MAX_DRY_SECTIONS) { setStatus("end"); return; }
      }
      setStatus("idle"); // nothing usable this round; the next scroll check tries again
    } catch (err) {
      if (gen !== genRef.current) return;
      setStatus(ctrl.signal.aborted ? "idle" : "error");
    } finally {
      if (gen === genRef.current) busy.current = false;
    }
  }, [status]);

  useEffect(() => () => { ctrlRef.current?.abort(); busy.current = false; }, []);

  const retry = useCallback(() => { fails.current = 0; setStatus("idle"); }, []);
  return { sections, status, loadMore, retry };
}

/* ------------------------------ UI ------------------------------ */

function PlayIcon({ playing }) {
  return playing ? (
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 5h4v14H6zM14 5h4v14h-4z" /></svg>
  ) : (
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z" /></svg>
  );
}

function MediaCard({ item, engine }) {
  const isCurrent = engine.item?.id === item.id;
  const playing = isCurrent && engine.playing;
  return (
    <li
      className={`card ${isCurrent ? "is-current" : ""}`}
      onPointerEnter={() => engine.warm(item)}
      onPointerLeave={engine.cancelWarm}
    >
      <div className="card-art">
        {item.thumbnailUrl ? <img src={item.thumbnailUrl} alt="" loading="lazy" decoding="async" /> : <span className="art-fallback"><Icon name="music" /></span>}
        <button
          type="button"
          className="fab"
          onFocus={() => engine.warm(item)}
          onClick={() => engine.toggle(item)}
          aria-label={`${playing ? "Pause" : "Play"} ${item.title} by ${item.subtitle}`}
        >
          <PlayIcon playing={playing} />
        </button>
      </div>
      <h3 className="card-title" title={item.title}>{item.title}</h3>
      <p className="card-sub" title={item.subtitle}>{item.subtitle}</p>
    </li>
  );
}

function SuggestionRow({ item, engine }) {
  const isCurrent = engine.item?.id === item.id;
  const playing = isCurrent && engine.playing;
  return (
    <li
      className={`row ${isCurrent ? "is-current" : ""}`}
      onPointerEnter={() => engine.warm(item)}
      onPointerLeave={engine.cancelWarm}
    >
      <button
        type="button"
        className="row-btn"
        onFocus={() => engine.warm(item)}
        onClick={() => engine.toggle(item)}
        aria-label={`${playing ? "Pause" : "Play"} ${item.title} by ${item.subtitle}`}
      >
        <span className="row-thumb">
          {item.thumbnailUrl ? <img src={item.thumbnailUrl} alt="" loading="lazy" decoding="async" /> : <span className="art-fallback"><Icon name="music" /></span>}
        </span>
        <span className="row-meta">
          <span className="row-title">{item.title}</span>
          <span className="row-sub">{item.subtitle}</span>
        </span>
        <span className="row-time">{item.duration}</span>
        <span className="row-play"><PlayIcon playing={playing} /></span>
      </button>
    </li>
  );
}

function Dock({ engine }) {
  const { item, playing, buffering, time, duration, error } = engine;
  if (!item) return null;
  return (
    <footer className="dock" role="region" aria-label="Now playing">
      <div className="dock-track">
        <div className="dock-art">{item.thumbnailUrl && <img src={item.thumbnailUrl} alt="" />}</div>
        <div className="dock-meta">
          <p className="dock-title" title={item.title}>{item.title}</p>
          <p className="dock-sub">{error ? "Playback failed — try again" : item.subtitle}</p>
        </div>
      </div>
      <div className="dock-controls">
        <button type="button" className="dock-play" onClick={() => engine.toggle(item)} aria-label={playing ? "Pause" : "Play"}>
          {buffering && !error ? <span className="spinner" aria-hidden="true" /> : <PlayIcon playing={playing} />}
        </button>
        <div className="dock-seek">
          <span>{fmt(time)}</span>
          <input
            type="range"
            min="0"
            max={Number.isFinite(duration) && duration > 0 ? duration : 0}
            step="1"
            value={Math.min(time, duration || 0)}
            onChange={(e) => engine.seek(Number(e.target.value))}
            aria-label="Seek"
          />
          <span>{fmt(duration)}</span>
        </div>
      </div>
    </footer>
  );
}

const MODES = [
  { id: "default", label: "Default" },
  { id: "recommended", label: "Recommended" },
];

function ModeSwitch({ mode, onChange }) {
  return (
    <div className="mode-bar">
      <span className="mode-label" id="mode-label">Mode</span>
      <div className="mode-switch" role="radiogroup" aria-labelledby="mode-label" data-mode={mode}>
        <span className="mode-thumb" aria-hidden="true" />
        {MODES.map((m) => (
          <button
            key={m.id}
            type="button"
            role="radio"
            aria-checked={mode === m.id}
            className={`mode-btn ${mode === m.id ? "is-active" : ""}`}
            onClick={() => onChange(m.id)}
          >
            {m.label}
          </button>
        ))}
      </div>
    </div>
  );
}

const RecoHeartIcon = ({ filled }) => (
  <svg viewBox="0 0 24 24" width="14" height="14" fill={filled ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 21s-7.5-4.6-10-9.3C.6 8.4 2.3 5 5.7 5c2 0 3.4 1.1 4.3 2.4C10.9 6.1 12.3 5 14.3 5c3.4 0 5.1 3.4 3.7 6.7C19.5 16.4 12 21 12 21z" />
  </svg>
);
const RecoPlusIcon = () => (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 5v14M5 12h14" />
  </svg>
);

function RecoCard({ item, isCurrent, playing, liked = false, onSelect, onWarm, onCancelWarm, onToggleLike, onAddToPlaylist }) {
  // Whole card is the click target.
  return (
    <li
      className={`rc ${isCurrent ? "is-current" : ""}`}
      onPointerEnter={() => onWarm?.(item)}
      onPointerDown={() => onWarm?.(item)}
      onPointerLeave={onCancelWarm}
    >
      <button
        type="button"
        className="rc-hit"
        onFocus={() => onWarm?.(item)}
        onClick={() => onSelect(item)}
        aria-label={`${playing ? "Pause" : "Play"} ${item.title} by ${item.subtitle}`}
      >
        <span className="rc-art">
          {item.thumbnailUrl
            ? <img src={item.thumbnailUrl} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" />
            : <span className="art-fallback"><Icon name="music" /></span>}
          {item.duration && <span className="rc-dur">{item.duration}</span>}
          <span className="rc-play"><PlayIcon playing={playing} /></span>
        </span>
        <span className="rc-title" title={item.title}>{item.title}</span>
        <span className="rc-artist" title={item.subtitle}>{item.subtitle}</span>
      </button>
      {(onToggleLike || onAddToPlaylist) && (
        <div className="rc-actions">
          {onToggleLike && (
            <button
              type="button"
              className={`rc-act like-btn ${liked ? "is-liked" : ""}`}
              aria-label={liked ? `Unlike ${item.title}` : `Like ${item.title}`}
              aria-pressed={liked}
              onClick={() => onToggleLike(item)}
            >
              <RecoHeartIcon filled={liked} />
            </button>
          )}
          {onAddToPlaylist && (
            <button
              type="button"
              className="rc-act"
              aria-label={`Save ${item.title} to a playlist`}
              onClick={() => onAddToPlaylist(item)}
            >
              <RecoPlusIcon />
            </button>
          )}
        </div>
      )}
    </li>
  );
}


/* ------------------- Artists strip + playlist shelves (Recommended) ------------------- */
const API_BASE = import.meta.env?.VITE_API_BASE_URL || "";
const ARTIST_COUNT = 12;
// A big pool; 12 are drawn at random each time the page opens (never the same 12 twice in a row).
const ARTIST_POOL = [
  "Arijit Singh", "Kishore Kumar", "Mohammed Rafi", "Lata Mangeshkar", "Atif Aslam", "Shreya Ghoshal",
  "Sonu Nigam", "Udit Narayan", "Kumar Sanu", "Alka Yagnik", "Jubin Nautiyal", "A. R. Rahman", "Pritam",
  "Nusrat Fateh Ali Khan", "Rahat Fateh Ali Khan", "Lucky Ali", "KK", "Mohit Chauhan", "Neha Kakkar",
  "Badshah", "Diljit Dosanjh", "Guru Randhawa", "Darshan Raval", "B Praak", "Armaan Malik", "Papon",
  "Shaan", "Sunidhi Chauhan", "Asha Bhosle", "Mukesh", "Hemant Kumar", "Manna Dey", "Talat Mahmood",
  "Jagjit Singh", "Ghulam Ali", "Mehdi Hassan", "Abhijeet Bhattacharya", "Sadhana Sargam", "Kavita Krishnamurthy",
  "Anuradha Paudwal", "Vishal Mishra", "Ankit Tiwari", "Palak Muchhal", "Sukhwinder Singh", "Mika Singh",
  "Yo Yo Honey Singh", "AP Dhillon", "Karan Aujla", "Sidhu Moose Wala", "Divine", "Raftaar", "Emiway Bantai",
  "Amit Trivedi", "Vishal-Shekhar", "Shankar Mahadevan", "Javed Ali", "Kailash Kher", "Harshdeep Kaur",
  "Monali Thakur", "Tulsi Kumar", "Stebin Ben", "Sachet Tandon", "Parampara Tandon", "Ritviz", "Prateek Kuhad",
  "Anuv Jain", "Arman Malik", "Rekha Bhardwaj", "Kunal Ganjawala", "Hariharan", "S. P. Balasubrahmanyam",
];
let lastArtistPick = [];
const pickArtists = () => {
  const fresh = ARTIST_POOL.filter((n) => !lastArtistPick.includes(n));
  const picked = shuffle(fresh).slice(0, ARTIST_COUNT);
  lastArtistPick = picked;
  return picked;
};
const artistInitials = (name) => String(name || "?").split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() || "").join("");
const artistCache = new Map(); // name -> artist object | null  (server also caches for 24h)

function ArtistBubble({ name, artist, onOpen, index }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [artist?.image]);
  const shown = artist?.name || name;
  return (
    <li className="as-item" style={{ "--i": index }}>
      <button type="button" className="as-btn" onClick={() => onOpen(artist || { name })} aria-label={`Open artist page for ${shown}`}>
        <span className="as-ring">
          <span className="as-avatar">
            {artist?.image && !failed
              ? <img src={artist.image} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setFailed(true)} />
              : <span className="as-initials" aria-hidden="true">{artistInitials(shown)}</span>}
          </span>
        </span>
        <span className="as-name" title={shown}>{shown}</span>
      </button>
    </li>
  );
}

/** One horizontal line of 10-12 artists, a fresh set every visit. */
function ArtistStrip({ onOpenArtist }) {
  const [names, setNames] = useState(pickArtists);
  const [artists, setArtists] = useState(() => Object.fromEntries([...artistCache.entries()].filter(([, v]) => v)));

  useEffect(() => {
    let alive = true;
    const todo = names.filter((n) => !artistCache.has(n));
    let cursor = 0;
    const worker = async () => {
      while (alive && cursor < todo.length) {
        const n = todo[cursor++];
        try {
          await whenPlaybackIdle(6000); // artist photos wait until the clicked song is playing
          const res = await fetch(`${API_BASE}/api/artist?q=${encodeURIComponent(n)}`);
          const data = res.ok ? await res.json() : null;
          artistCache.set(n, data?.artist || null);
          if (alive && data?.artist) setArtists((prev) => ({ ...prev, [n]: data.artist }));
        } catch { artistCache.set(n, null); }
      }
    };
    Promise.all([worker(), worker(), worker(), worker()]);
    return () => { alive = false; };
  }, [names]);

  const rowRef = useRef(null);
  const nudge = (dir) => rowRef.current?.scrollBy({ left: dir * Math.max(240, rowRef.current.clientWidth * 0.8), behavior: "smooth" });

  return (
    <section className="reco-band" aria-labelledby="as-title">
      <div className="reco-band-head">
        <h3 id="as-title" className="reco-section-title">Artists For You</h3>
        <div className="as-arrows">
          <button type="button" className="as-arrow" onClick={() => nudge(-1)} aria-label="Scroll artists left">‹</button>
          <button type="button" className="as-arrow" onClick={() => nudge(1)} aria-label="Scroll artists right">›</button>
        </div>
        <button type="button" className="reco-mini-btn" onClick={() => setNames(pickArtists())} title="Show different artists">
          <Icon name="dice" /> Shuffle
        </button>
      </div>
      <ul className="as-row" aria-label="Suggested artists" ref={rowRef}>
        {names.map((n, i) => <ArtistBubble key={n} name={n} artist={artists[n]} index={i} onOpen={onOpenArtist} />)}
      </ul>
    </section>
  );
}

function PlaylistCard({ pl, active, onSelect }) {
  return (
    <li className="pc-item">
      <button type="button" className={`pc ${active ? "is-active" : ""}`} onClick={() => onSelect(pl.id)} aria-label={`Open playlist ${pl.label}`}>
        <span className={`pc-cover pc-cover--${pl.thumbs.length >= 4 ? "mosaic" : pl.thumbs.length ? "single" : "plain"}`}>
          {pl.thumbs.length >= 4
            ? pl.thumbs.slice(0, 4).map((t, i) => <img key={i} src={t} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" />)
            : pl.thumbs.length
              ? <img src={pl.thumbs[0]} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" />
              : <span className="pc-glyph"><Icon name={pl.kind === "radio" ? "radio" : "listMusic"} /></span>}
          <span className="pc-play" aria-hidden="true"><PlayIcon playing={false} /></span>
          {active && <span className="pc-badge">Now</span>}
        </span>
        <span className="pc-title" title={pl.label}>{pl.label}</span>
        <span className="pc-sub">{pl.kind === "radio" ? "Radio playlist" : `${pl.count} song${pl.count === 1 ? "" : "s"}`}</span>
      </button>
    </li>
  );
}

/** A horizontal shelf of playlists, dropped in between the song shelves. */
function PlaylistShelf({ items, activeId, onSelect, title }) {
  return (
    <div className="reco-section reco-section--playlists">
      <h3 className="reco-section-title">{title}</h3>
      <ul className="pc-row">
        {items.map((pl) => <PlaylistCard key={pl.id} pl={pl} active={pl.id === activeId} onSelect={onSelect} />)}
      </ul>
    </div>
  );
}

// Playlist shelves appear only 4 times, with wide gaps (after the 3rd, 8th, 14th and 21st song shelf).
const PLAYLIST_SHELF_AT = [2, 7, 13, 20];
const PLAYLIST_SHELF_TITLES = ["Your Playlists", "Jump Into a Playlist", "Playlists You Might Like", "Pick a Playlist"];

const greeting = () => {
  const h = new Date().getHours();
  return h < 5 ? "Late night vibes" : h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : h < 21 ? "Good evening" : "Good night";
};

/** Floating "back to top" button: appears after scrolling down the Recommended page. */
function BackToTop() {
  const [show, setShow] = useState(false);
  useEffect(() => {
    const on = () => setShow(window.scrollY > 700);
    on();
    window.addEventListener("scroll", on, { passive: true });
    return () => window.removeEventListener("scroll", on);
  }, []);
  return (
    <button
      type="button"
      className={`reco-top-btn ${show ? "is-visible" : ""}`}
      onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
      aria-label="Back to top"
      tabIndex={show ? 0 : -1}
    >
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="18 15 12 9 6 15" /></svg>
    </button>
  );
}

/** In-page Mode switch (same segmented look as the sidebar / topbar). */
function ModePills({ mode, onChange }) {
  return (
    <div className="mode-pills" role="radiogroup" aria-label="Mode" data-mode={mode}>
      <span className="mode-pills-thumb" aria-hidden="true" />
      {[["default", "Default", "radio"], ["recommended", "Recommended", "sparkles"]].map(([id, label, icon]) => (
        <button key={id} type="button" role="radio" aria-checked={mode === id} className={`mode-pills-btn ${mode === id ? "is-active" : ""}`} onClick={() => onChange(id)}>
          <Icon name={icon} /> {label}
        </button>
      ))}
    </div>
  );
}

/** Host-agnostic grid: the host decides how a picked track is played. */
export function RecommendedGrid({ currentId, playing = false, likedIds, onSelect, onWarm, onCancelWarm, onToggleLike, onAddToPlaylist, onOpenArtist, playlists, activePlaylistId, onSelectPlaylist, mode, onModeChange }) {
  const [mood, setMood] = useState("all");
  const { sections, status, loadMore, retry } = usePipedFeed(mood);
  const enabled = status === "idle";
  // Playlists (your own + radio) offered between the song shelves.
  const playlistItems = useMemo(() => {
    const custom = (playlists?.custom || []).map((p) => ({
      id: p.id, label: p.label, kind: "custom", count: p.tracks?.length || 0,
      thumbs: (p.tracks || []).slice(0, 4).map((t) => `https://i.ytimg.com/vi/${t.id}/mqdefault.jpg`),
    }));
    const radio = (playlists?.radio || []).map((p) => ({ id: p.id, label: p.label, kind: "radio", count: 0, thumbs: [] }));
    return [...custom, ...radio];
  }, [playlists]);
  // Stable per-shelf order (so shelves don't reshuffle on every re-render).
  const shelfOrder = useRef({ src: null, map: {} });
  const orderFor = (idx) => {
    if (shelfOrder.current.src !== playlistItems) shelfOrder.current = { src: playlistItems, map: {} };
    const m = shelfOrder.current.map;
    if (!m[idx]) m[idx] = idx === PLAYLIST_SHELF_AT[0] ? playlistItems : shuffle(playlistItems);
    return m[idx];
  };
  // Re-subscribes (and re-checks position) each time a shelf lands, so the
  // first shelf loads immediately and a tall viewport keeps filling.
  useNearBottom(loadMore, enabled, sections.length);

  // Pre-resolve the first few cards of each new shelf (staggered) so the
  // first tap on a recommended track starts almost instantly.
  const warmRef = useRef(onWarm);
  warmRef.current = onWarm;
  useEffect(() => {
    const latest = sections[sections.length - 1];
    if (!latest) return undefined;
    const timers = latest.items.slice(0, 3).map((it, i) =>
      setTimeout(() => warmRef.current?.(it), 400 + i * 400)
    );
    return () => timers.forEach(clearTimeout);
  }, [sections.length]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <section className="reco" aria-labelledby="reco-title">
      {onModeChange && (
        <div className="reco-modebar"><ModePills mode={mode} onChange={onModeChange} /></div>
      )}
      <header className="reco-head">
        <span className="reco-chip" aria-hidden="true" />
        <p className="reco-greet">{greeting()} <span aria-hidden="true">·</span> let the music pick you</p>
        <h2 id="reco-title" className="reco-title">Recommended For You</h2>
        <p className="reco-sub">Fresh picks every visit — keep scrolling.</p>
        <div className="mood-chips" role="tablist" aria-label="Pick a mood">
          {MOODS.map((m) => (
            <button
              key={m.id}
              type="button"
              role="tab"
              aria-selected={mood === m.id}
              className={`mood-chip ${mood === m.id ? "is-active" : ""}`}
              onClick={() => setMood(m.id)}
            >
              <Icon name={m.icon} /> {m.label}
            </button>
          ))}
        </div>
      </header>

      {onOpenArtist && <ArtistStrip onOpenArtist={onOpenArtist} />}

      {sections.map((sec, idx) => (
        <React.Fragment key={sec.key}>
        {playlistItems.length > 0 && onSelectPlaylist && PLAYLIST_SHELF_AT.includes(idx) && (
          <PlaylistShelf
            title={PLAYLIST_SHELF_TITLES[PLAYLIST_SHELF_AT.indexOf(idx) % PLAYLIST_SHELF_TITLES.length]}
            items={orderFor(idx)}
            activeId={activePlaylistId}
            onSelect={onSelectPlaylist}
          />
        )}
        <div className="reco-section">
          <h3 className="reco-section-title">{sec.title}</h3>
          <ul className="rc-grid">
            {sec.items.map((it) => (
              <RecoCard
                key={it.id}
                item={it}
                isCurrent={currentId === it.id}
                playing={currentId === it.id && playing}
                liked={Boolean(likedIds?.has(it.id))}
                onSelect={onSelect}
                onWarm={onWarm}
                onCancelWarm={onCancelWarm}
                onToggleLike={onToggleLike}
                onAddToPlaylist={onAddToPlaylist}
              />
            ))}
          </ul>
        </div>
        </React.Fragment>
      ))}

      {status === "loading" && (
        <div className="reco-section" aria-hidden="true">
          <div className="reco-skel-title" />
          <ul className="rc-grid">
            {Array.from({ length: 6 }, (_, i) => <li key={i} className="rc rc-skel" />)}
          </ul>
        </div>
      )}
      {status === "error" && (
        <p className="reco-note">
          Couldn’t load more right now.{" "}
          <button type="button" className="rc-retry" onClick={retry}>Try again</button>
        </p>
      )}
      {status === "end" && <p className="reco-note">You’ve reached the end — for now.</p>}
      <BackToTop />
    </section>
  );
}

export default function Dashboard({ endpoint = "/api/media-grid", onTrackChange }) {
  const engine = useAudioEngine();

  // Lets a host shell (App.jsx) react to track changes, e.g. rotate the backdrop.
  const onTrackChangeRef = useRef(onTrackChange);
  onTrackChangeRef.current = onTrackChange;
  const currentId = engine.item?.id;
  useEffect(() => { if (currentId) onTrackChangeRef.current?.(currentId); }, [currentId]);
  const [items, setItems] = useState([]);
  const [status, setStatus] = useState("loading");
  const [mode, setMode] = useState("default"); // "default" | "recommended"

  useEffect(() => {
    const ctrl = new AbortController();
    fetch(endpoint, { signal: ctrl.signal })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d) => { setItems(Array.isArray(d.items) ? d.items : []); setStatus("ready"); })
      .catch((e) => e.name !== "AbortError" && setStatus("error"));
    return () => ctrl.abort();
  }, [endpoint]);

  const jumpBackIn = items.slice(0, 6);
  const recommended = items.slice(6, 14);

  return (
    <div className={`dash ${engine.item ? "has-dock" : ""}`}>
      <main className="dash-main">
        <ModeSwitch mode={mode} onChange={setMode} />
        {mode === "recommended" && (
          <RecommendedGrid
            currentId={engine.item?.id}
            playing={engine.playing}
            onSelect={engine.toggle}
            onWarm={engine.warm}
            onCancelWarm={engine.cancelWarm}
          />
        )}
        {mode === "default" && status === "loading" && <p className="dash-note">Loading…</p>}
        {mode === "default" && status === "error" && <p className="dash-note">Couldn’t load your library.</p>}
        {mode === "default" && status === "ready" && (
          <>
            <section aria-labelledby="jbi">
              <h2 id="jbi" className="section-title">Jump Back In</h2>
              <ul className="grid">
                {jumpBackIn.map((it) => <MediaCard key={it.id} item={it} engine={engine} />)}
              </ul>
            </section>
            {recommended.length > 0 && (
              <section aria-labelledby="rec">
                <h2 id="rec" className="section-title">Recommended For You</h2>
                <ul className="rows">
                  {recommended.map((it) => <SuggestionRow key={it.id} item={it} engine={engine} />)}
                </ul>
              </section>
            )}
          </>
        )}
      </main>
      <Dock engine={engine} />
    </div>
  );
}

import { useState, useRef, useEffect } from "react";
import React from "react";

// Supabase
const SUPABASE_URL = "https://tlgogogaielulbzwmmkt.supabase.co";
const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRsZ29nb2dhaWVsdWxiendtbWt0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE1MzEwNjksImV4cCI6MjA5NzEwNzA2OX0.-Di1dQgE1-3sgYBJk5N76eiVzUk2TgFTnaE1YOB4__E";

const supabase = (() => {
  const headers = { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json" };
  const authUrl = `${SUPABASE_URL}/auth/v1`;
  return {
    auth: {
      signUp: async ({email, password}) => {
        const r = await fetch(`${authUrl}/signup`, {method:"POST", headers, body: JSON.stringify({email, password})});
        return r.json();
      },
      signInWithPassword: async ({email, password}) => {
        const r = await fetch(`${authUrl}/token?grant_type=password`, {method:"POST", headers, body: JSON.stringify({email, password})});
        const data = await r.json();
        if (data.access_token) localStorage.setItem("sb_session", JSON.stringify(data));
        return data;
      },
      signOut: async () => {
        localStorage.removeItem("sb_session");
      },
      getSession: () => {
        try {
          const s = JSON.parse(localStorage.getItem("sb_session")||"null");
          if (!s || !s.access_token) return null;
          const payload = JSON.parse(atob(s.access_token.split('.')[1]));
          if (payload.exp && payload.exp < Date.now()/1000) {
            // access_token abgelaufen → hier null zurückgeben, ABER die gespeicherte
            // Session NICHT löschen: der refresh_token lebt länger und wird gebraucht,
            // um sich ohne Passwort einen frischen access_token zu holen.
            return null;
          }
          return s;
        } catch {
          localStorage.removeItem("sb_session");
          return null;
        }
      }
    }
  };
})();

// ============================================================
// ACCOUNT-SWITCHER (nur für Admins sichtbar)
// ============================================================
// Anders als zuvor NICHT mehr nur lokal im Browser gespeichert, sondern in der
// admin_known_accounts-Tabelle — damit die gleiche Liste auf jedem Gerät erscheint,
// auf dem man sich als Admin einloggt (Handy, anderer PC, usw.).

const dbHeadersFor = (token) => ({
  "apikey": SUPABASE_KEY, "Authorization": `Bearer ${token || SUPABASE_KEY}`,
  "Content-Type": "application/json"
});

// Lädt die gemerkten Accounts EINER bestimmten Person (ownerId = die eigene Admin-ID) —
// jeder Admin sieht nur seine eigene Liste.
const getKnownAccounts = async (ownerId, token) => {
  if (!ownerId) return [];
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/admin_known_accounts?owner_id=eq.${ownerId}&order=last_used.desc`, {headers: dbHeadersFor(token)});
    const data = await r.json();
    return Array.isArray(data) ? data : [];
  } catch { return []; }
};

// Speichert/aktualisiert einen Account in der Liste — anhand der E-Mail aus dem Token,
// für die übergebene ownerId (die eigene Admin-ID).
const rememberAccount = async (sessionData, ownerId, token) => {
  try {
    if (!sessionData?.access_token || !ownerId) return;
    const payload = JSON.parse(atob(sessionData.access_token.split('.')[1]));
    const email = payload.email || "";
    if (!email) return;
    await fetch(`${SUPABASE_URL}/rest/v1/admin_known_accounts`, {
      method: "POST", headers: {...dbHeadersFor(token), "Prefer": "resolution=merge-duplicates"},
      body: JSON.stringify({ owner_id: ownerId, account_email: email, refresh_token: sessionData.refresh_token || null, last_used: new Date().toISOString() })
    });
  } catch {}
};

// Eigene, ISOLIERTE Login-Funktion für den Account-Switcher — bewusst NICHT über
// supabase.auth.signInWithPassword, weil die direkt localStorage["sb_session"]
// überschreibt. Das hätte (auch wenn man es danach wieder zurücksetzt) ein Zeitfenster
// geöffnet, in dem jeder andere Teil der App, der live aus localStorage liest (z.B.
// getUserId()), versehentlich mit der ID des NEUEN Accounts arbeitet — z.B. ein parallel
// laufender Auto-Save-Timer, der dann Daten unter der falschen User-ID wegschreibt.
// Diese Funktion spricht den Login-Endpunkt direkt an und lässt den bestehenden
// localStorage-Eintrag während der ganzen Zeit komplett unangetastet.
const loginWithoutTouchingSession = async (email, password) => {
  const headers = { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json" };
  const r = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {method:"POST", headers, body: JSON.stringify({email, password})});
  return r.json();
};

// Holt sich mit dem REFRESH-Token einen frischen access_token, ohne Passwort erneut
// einzugeben — der access_token allein läuft normalerweise nach etwa einer Stunde ab,
// der refresh_token bleibt deutlich länger gültig. Genau das macht den Account-Switcher
// erst dauerhaft brauchbar: ohne das hier würde ein gemerkter Account nach einer Stunde
// nicht mehr funktionieren, weil sein gespeicherter access_token verfallen ist.
const refreshAccountToken = async (refresh_token) => {
  if (!refresh_token) return null;
  try {
    const headers = { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json" };
    const r = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {method:"POST", headers, body: JSON.stringify({refresh_token})});
    const data = await r.json();
    return data.access_token ? data : null;
  } catch { return null; }
};

// Wechselt zu einem gemerkten Account — holt sich davor IMMER erst einen frischen
// access_token über den refresh_token, damit es egal ist, wie lange der Account schon
// nicht mehr aktiv war. Erst wenn das klappt, wird die Session wirklich gewechselt
// und neu geladen.
// Schlüssel für den "Heimat-Admin"-Marker: merkt sich lokal auf diesem Gerät, wer der
// eigentliche Admin-Account ist, von dem aus zu einem Test-Account gewechselt wurde.
// Notwendig, damit die Admin-Bar auch sichtbar bleibt, WÄHREND man im Test-Account ist
// (der ja selbst kein Admin ist) — sonst gäbe es keinen Weg mehr zurück.
const HOME_ADMIN_KEY = "lenni_home_admin_session";

const switchToAccount = async (entry, ownerId, currentToken, onSwitching) => {
  if (onSwitching) onSwitching(entry.id);
  const fresh = await refreshAccountToken(entry.refresh_token);
  if (!fresh) {
    if (onSwitching) onSwitching(null);
    alert("Konnte nicht zu diesem Account wechseln — der gespeicherte Zugang ist nicht mehr gültig. Bitte einmal neu über \"Account hinzufügen\" einloggen.");
    return;
  }
  // Bevor gewechselt wird: die AKTUELLE Session als Heimat-Marker sichern — aber NUR
  // falls noch keiner existiert. Sonst würde ein Wechsel von Test-Account A zu B den
  // echten Admin-Marker überschreiben, und man fände am Ende nicht mehr zum Admin
  // zurück, sondern nur noch zu A.
  if (!localStorage.getItem(HOME_ADMIN_KEY)) {
    const currentSession = JSON.parse(localStorage.getItem("sb_session") || "null");
    if (currentSession) localStorage.setItem(HOME_ADMIN_KEY, JSON.stringify(currentSession));
  }
  localStorage.setItem("sb_session", JSON.stringify(fresh));
  // Account-Liste gleich mit dem frischen refresh_token aktualisieren (er kann sich
  // bei jeder Erneuerung ändern), damit der nächste Wechsel ebenfalls sofort klappt.
  await rememberAccount(fresh, ownerId, currentToken);
  window.location.reload();
};

// Wechselt direkt zurück zum Heimat-Admin-Account — mit demselben Refresh-Mechanismus
// wie switchToAccount, damit es egal ist, wie lange man im Test-Account unterwegs war.
const switchBackToHomeAdmin = async () => {
  const home = JSON.parse(localStorage.getItem(HOME_ADMIN_KEY) || "null");
  if (!home) return false;
  const fresh = await refreshAccountToken(home.refresh_token);
  if (!fresh) {
    alert("Konnte nicht zum Admin-Account zurückwechseln — bitte einmal ganz normal neu einloggen.");
    return false;
  }
  localStorage.setItem("sb_session", JSON.stringify(fresh));
  localStorage.removeItem(HOME_ADMIN_KEY);
  window.location.reload();
  return true;
};

const forgetAccount = async (id, token) => {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/admin_known_accounts?id=eq.${id}`, {method:"DELETE", headers: dbHeadersFor(token)});
  } catch {}
};

const CARDS={"1":{"name":"Der Reiter","kw":"Nachrichten, Neuigkeiten, Projekte, Pläne, Transportmittel, eventuell ein junger Mann"},"2":{"name":"Der Klee","kw":"Kleines Glück, schnelles Eingreifen, Schutz vor negativen Energien"},"3":{"name":"Das Schiff","kw":"Reise, Geschäft, Erbschaft, Transport, Expansion, Verstehen, Toleranz"},"4":{"name":"Das Haus","kw":"Themen die dir momentan am wichtigsten sind, Heim, Familie, Immobilien"},"5":{"name":"Der Baum","kw":"Wachstum, Reife, Gesundheit, langer Zeitraum, Natur, Geduld"},"6":{"name":"Die Wolken","kw":"Helle oder dunkle Seite, Unklarheiten, Hindernisse, Rückschläge, älterer Herr"},"7":{"name":"Die Schlange","kw":"Mutter, Intelligenz, Versuchung, Konkurrenz, Umwege, Gift und Heilmittel"},"8":{"name":"Der Sarg","kw":"Ende, Abschluss, Blockade, Stille, was nicht mehr lebt"},"9":{"name":"Die Blumen","kw":"Glück, Freude, Schönheit, Einladung, Überraschung, Frau, Blumen"},"10":{"name":"Die Sense","kw":"Trennung, Schnitt, Entscheidung, Ernte, Gefahr, Absage"},"11":{"name":"Die Ruten","kw":"Diskussionen, Gespräche, Streit, Ideen, Kommunikation"},"12":{"name":"Die Vögel","kw":"Gespräche, Gerüchte, Nervosität, Stress, Anrufe, Lärm"},"13":{"name":"Das Kind","kw":"Neuanfang, Kind, Unschuld, Wunscherfüllung, Überraschung"},"14":{"name":"Der Fuchs","kw":"Hinterlist, Betrug, Intrigen, Schläue, Klugheit, Instinkt, Arbeit"},"15":{"name":"Der Bär","kw":"Durchsetzungskraft, Besitz, Schutz, Kraft, Aggression, Chef, Finanzen"},"16":{"name":"Die Sterne","kw":"Wünsche, Träume, Spiritualität, Hoffnung, Erfolg, große Projekte"},"17":{"name":"Die Störche","kw":"Veränderungen, Umzug, Bewegung, Transformation, Neubeginn"},"18":{"name":"Der Hund","kw":"Treue, Freundschaft, Unterstützung, Beständigkeit, Vertrauen"},"19":{"name":"Der Turm","kw":"Grenze, Einsamkeit, Isolation, Behörde, Institution, Distanz"},"20":{"name":"Der Park","kw":"Gesellschaft, Öffentlichkeit, Events, Netzwerk, wo Menschen sich begegnen"},"21":{"name":"Der Berg","kw":"Hindernisse, langer Aufstieg, Anstrengung, Feind, Blockade"},"22":{"name":"Die Wege","kw":"Entscheidungen, Alternativen, Kreuzweg, Richtungswechsel"},"23":{"name":"Die Mäuse","kw":"Verlust, Kummer, Krankheit, Diebstahl, Angst, Nagen, Parasiten"},"24":{"name":"Das Herz","kw":"Liebe, Herz, Gefühle, Leidenschaft, Glück, Zuneigung"},"25":{"name":"Der Ring","kw":"Beziehungen, Ehe, Bindung, Partnerschaft, Vertrag, Versprechen"},"26":{"name":"Das Buch","kw":"Geheimnis, Wissen, Studium, Ausbildung, Überraschung, im Verborgenen"},"27":{"name":"Der Brief","kw":"Persönliche Botschaften, Brief, SMS, E-Mail, Dokumente"},"28":{"name":"Der Herr","kw":"Männliche Person, sehr persönlich, aktiv, extrovertiert"},"29":{"name":"Die Dame","kw":"Weibliche Person, sehr persönlich, passiv, introvertiert"},"30":{"name":"Die Lilien","kw":"Familie, Moral, Alter, Sexualität, Winter, Lilien, Reinheit"},"31":{"name":"Die Sonne","kw":"Energie, Glücksfälle, Erfolg, wahre Liebe, Kraft, Licht, Sommer"},"32":{"name":"Der Mond","kw":"Ruhm, Ehre, Anerkennung, Innenleben, Seele, Intuition, Mond"},"33":{"name":"Der Schlüssel","kw":"Mit Sicherheit, Erfolg, gutes Gelingen, Neubeginn, Schlüssel zur Antwort"},"34":{"name":"Die Fische","kw":"Geld, Glück, Wohlstand, Zufriedenheit, Ressourcen, Fülle"},"35":{"name":"Der Anker","kw":"Beruf, Arbeit, Stabilität, Heimathafen, Beständigkeit, Anker"},"36":{"name":"Das Kreuz","kw":"Bedeutungsvolle Ereignisse, Schicksal, Bestimmung, Prüfung, Karma"}};
const SYMBOLS={"1":"🐎","2":"🍀","3":"⛵","4":"🏠","5":"🌳","6":"☁️","7":"🐍","8":"⚰️","9":"💐","10":"⚔️","11":"🪄","12":"🐦","13":"👶","14":"🦊","15":"🐻","16":"⭐","17":"🦢","18":"🐕","19":"🗼","20":"🌳","21":"⛰️","22":"🛤️","23":"🐭","24":"❤️","25":"💍","26":"📖","27":"✉️","28":"🎩","29":"👒","30":"🌸","31":"☀️","32":"🌙","33":"🗝️","34":"🐟","35":"⚓","36":"✝️"};
const MATRIX={"1":{"gendanken":"Vielleicht denkst du zu viel über alles nach, jagst die Gedanken vom Ästchen zum Stöckchen und kommst nicht zur Ruhe. Oder du überlegst, wie du in dieser Situation die richtigen Worte finden kannst.","rat_der_engel":"Schlechte Nachrichten kommen, wann sie wollen; aber es ist nicht schicklich, ihnen entgegenzutreten.","warnung":"Es kann sein, dass du überall mitmischen möchtest. Dadurch vergeudest du deine wertvolle Energie, die du für deine Ziele einsetzen solltest.","wo_es_herkommt":"Mitunter zweifelst du an der Richtigkeit deines Tuns und deiner Entscheidungen. Dennoch bist du stolz auf dein unabhängiges Denken und du nimmst anderer Leute Ansichten nicht einfach unbewiesen hin.","ergebnis_und_wann":"Als Ergebnis kommen schon bald neue Chancen und Möglichkeiten, Neuigkeiten und die Nachrichten davon, auf dich zu. Sehr schnell, ohne weitere Zeitverzögerung."},"2":{"gendanken":"Anstatt andere ständig zu kritisieren solltest du eher motivierend wirken, dann steigt deine Laune in den Himmel.","rat_der_engel":"Mit dem Glück geht es, wie mit der Brille: Man hat sie auf der Nase und weiß es nicht.","warnung":"Es kann sein, dass dir eine gute Gelegenheit entgeht, derweil du auf eine bessere wartest.","wo_es_herkommt":"Auch wenn du dir deiner Sache nicht immer sicher bist, ahnst du doch, wenn du ehrlich zu dir selbst bist, dass du in Wahrheit ein Glückskind bist.","ergebnis_und_wann":"Dies ist deine Chance! So eine gute Gelegenheit sollte nicht ungenutzt vorbei gehen. Was du auch vor hast, du wirst Glück damit haben. In 2–3 Tagen."},"3":{"gendanken":"Deine Gedanken sind von einer Sehnsucht gezeichnet, Sehnsucht nach Liebe und Anerkennung; nach einem Leben voller Liebe, Hingabe und Harmonie, das du schon sehen kannst in einiger Ferne.","rat_der_engel":"Lass die Dinge auf dich zukommen, überstürze nichts und handle mit bedacht.","warnung":"Alles, was jetzt auf dich zu kommt, ist von größer Bedeutung für dich und dein Leben. Übe dich in Toleranz.","wo_es_herkommt":"Große Sehnsucht und der Wunsch nach Erfüllung hat dich immer weiter voran getrieben, auch wenn es lange gedauert hat, so hat es dich doch bis hier her gebracht.","ergebnis_und_wann":"Diese Sehnsucht wird Erfüllung finden, du brauchst nur noch etwas Geduld. In einigen Monaten; bis zu einem Jahr."},"4":{"gendanken":"Deine Gedanken drehen sich oft um die Familie, ob es allen gut geht, wie es besser gehen kann und der gleichen mehr.","rat_der_engel":"Ein sicheres Gebäude bedarf eines festen Fundaments. Prüfe es nach und bessere es ggf. aus.","warnung":"Plane vorsichtig, um nicht die eigene Stabilität und Schutz zu gefärden.","wo_es_herkommt":"Die Ursache ist in deiner Kindheit zu suchen. Vielleicht denkst du, dass du nicht die Liebe und Geborgenheit bekommen hattest, die du brauchtest; aber kannst du da wirklich ganz sicher sein?","ergebnis_und_wann":"Du wirst mit dem Ergebnis mehr als zufrieden sein; es bringt für längere Zeit Sicherheit und Stabilität. Am Abend, in der Nacht, am Ende des Jahres oder auch im Winter."},"5":{"gendanken":"Du denkst manchmal zu viel und wenn du am Ende deiner Gedankenkette angekommen bist, beginnst du wieder von Neuem, wie bei einer Langspielplatte.","rat_der_engel":"Wenn du es eilig hast, solltest du dir Zeit lassen! Geduld ist Wachsen, Ungeduld ist leiden!","warnung":"Dein Projekt hat weitreichende Konsequenzen! Prüfe, ob du alles bedacht hast und treibe keinen Raubbau an dir selbst. Pflege alte Freundschaften, das wird sich auszahlen.","wo_es_herkommt":"Die Ursache für diese Situation wurde schon vor sehr langer Zeit gesetzt. Eine vorschnelle Reaktion, eine leichtfertige Zusage und schon bist du für lange Zeit verpflichtet.","ergebnis_und_wann":"Diese Situation muss noch reifen und sich auswachsen. Du wirst ein ganzes Stück über dich hinaus gewachsen sein. Es dauert noch 9–12 Monate."},"6":{"gendanken":"Du versuchst, ein Problem mit dem Kopf zu lösen und schiebst es in Gedanken immerzu hin und her.","rat_der_engel":"Schwierigkeiten sind Herausforderungen, an denen wir wachsen können. Für jedes Problem gibt es eine Lösung und wenn nicht, dann löse dich von dem Problem.","warnung":"Achtung! Es könnte im Moment an Durchblick fehlen. Entweder weil nicht alle Einzelheiten bekannt sind, oder weil der Blick verstellt ist.","wo_es_herkommt":"Die Ursache für diese Situation liegt völlig im Unklaren, vielleicht weil sie ausserhalb liegt und du sie daher nicht erkennen kannst, vielleicht aber auch, weil du noch nicht so genau hinsehen möchtest. Frage später erneut.","ergebnis_und_wann":"Jede noch so dunkle Wolke zieht einmal vorüber. Wenn du nach der Zeit fragst, dann kann es darüber wieder Herbst werden."},"7":{"gendanken":"Deine Gedanken nehmen verschlungene Pfade. Nicht alles ist so kompliziert, wie du denkst.","rat_der_engel":"Laß dich nicht von Versprechungen und falschen Tatsachen verführen!","warnung":"Achtung! Es kann sein, dass dich jemand in deiner Nähe hereinlegen will. Verführungen locken und auch Gewissensbisse.","wo_es_herkommt":"Du hast in einem bestimmten Augenblick zu lange gezögert, weil du dich nicht ganz sicher warst, das richtige zu tun.","ergebnis_und_wann":"Es ist kompliziert und wirklich verwickelt. Es ist auch nicht immer alles Gold, was glänzt. Das kann sich noch ein halbes Jahr so dahin schlängeln."},"8":{"gendanken":"An einem gewissen Punkt kommst du in deinen Gedanken nicht weiter. So passiert es, dass du die Situation nicht zuende denken kannst, was aber überaus wichtig wäre.","rat_der_engel":"Aus Schaden soll man klug werden! Laß los und beginne noch einmal von vorne.","warnung":"Halte nicht an etwas fest, was schon lange nicht mehr da ist oder dir nicht (mehr) gut tut!","wo_es_herkommt":"Aus einer langanhaltenden Müdigkeit aus Energiemangel heraus. ev. auch wegen Schlafmangel oder Schlafstörungen","ergebnis_und_wann":"Alles ist zu etwas gut und so entsteht auch aus dieser Situation etwas schönes Neues. Nur eben momentan tut sich grad mal nichts."},"9":{"gendanken":"Du schwebst gedanklich auf Wolke 7. Entweder weil du frisch verliebt bist, ein tolles Projekt am Start hast oder einfach nur vor lauter Vorfreude.","rat_der_engel":"Alles, was du jetzt beginnst, wird dir auch gelingen; also pack es an! Pack jetzt viel an!","warnung":"Auch wenn dir im Moment alles zuzufliegen scheint, geh mit dieser Energie achtsam um, und teil sie dir gut ein; vielleicht indem du sie mit anderen teilst.","wo_es_herkommt":"Manchmal reicht ein kurzer Blick, ein kleines Wort und alles ist ganz klar und deutlich; nur ist es oft als Auslöser in Vergessenheit geraten.","ergebnis_und_wann":"Es wird dir gut gelingen und die Situation geht gut für dich aus. Im Frühling."},"10":{"gendanken":"Du bist dir nicht sicher, ob du dich genug angestrengt hast, ob du dich wirklich von der besten Seite gezeigt hast, gute genug bist, um dein Ziel wirklich zu erreichen. Du bist es erst dann wert, wenn du dich dafür hälst.","rat_der_engel":"Überstürze nichts und bleib besonnen. Wird sich wirklich das von dir erwünschte Ziel einstellen, wenn du auf diese Weise weiter machst?","warnung":"Vorsicht: Verletzungsgefahr! Dabei ist aber nicht immer nur der physische Aspekt einer Verletzung gemeint.","wo_es_herkommt":"Eine plötzliche Veränderung oder ein Schrecken hat eine Energie ins Universum geschickt, die nun in dreifacher Kraft zu uns zurück kommt. Ihr muss gut parriert werden, auf die eine oder andere Weise.","ergebnis_und_wann":"Wenn man fleißig war und sich angestrengt hat, folgt eine reiche Ernte. Wenn nicht, dann muss man sehen, was man dann bekommt. Es geschieht sehr plötzlich."},"11":{"gendanken":"Ja–Nein–ich meine Jain! So geht es den ganzen Tag in deinem Kopf umher, gerade so, als würden sich zwei Stimmen streiten. Hier streiten sich Herz und Verstand.","rat_der_engel":"Bevor du etwas unternimmst, hole dir kompetenten Rat ein. Hier ist es wirklich sinnvoll, noch einmal die Beraterin deines Vertrauens aufzusuchen, du kannst aber auch deine Mom fragen, wie sie reagieren würde.","warnung":"Denke nach, bevor du sprichst und überlege dir genau, was du sagst!","wo_es_herkommt":"Meinungsverschiedenheiten und eventuell anschließender Starrsinn haben dich an diesen Punkt gebracht.","ergebnis_und_wann":"Es endet in einer Auseinandersetzung und das weißt du auch. Und weil du diese Auseinandersetzung scheust, dauert es doppelt so lange, als es dauern müßte."},"12":{"gendanken":"Manchmal machst du dir einfach zu viele Sorgen. Und vielleicht hoffst du nun auf einen Anruf oder eine Nachricht, die dich aus den Sorgen heraus lösen.","rat_der_engel":"Geh auf Geschimpfe und Getratsche nicht ein, dann wird's auch bald vorüber sein.","warnung":"Lass dich von den Sorgen und der Hektik, die dich umgeben, nicht mitreißen!","wo_es_herkommt":"Diese Situation ist durch Stress und Hektik verbunden. Vielleicht auch, weil einige Flüchtigkeitsfehler begangen wurden.","ergebnis_und_wann":"Das Ergebnis ist nicht mit der Mühe zu vergleichen, die es zu erreichen, gekostet haben mag. Du wirst enttäuschend sein. im Oktober"},"13":{"gendanken":"Vielleicht macht man sich manchmal zu wenig Gedanken und nimmt es zu sehr auf die leichte Schulter. Das muss nicht unbedingt falsch sein, macht aber einen recht naiven Eindruck.","rat_der_engel":"Das sicherste Mittel, Kinder (Partner, Dinge, Situationen) zu verlieren ist, sie für immer behalten zu wollen.","warnung":"Verhalte dich nicht zu naiv und kindisch. Nichts ist so unschuldig, wie ein Kind und nicht so offen, wie ein neuer Anfang!","wo_es_herkommt":"Naivität in einer Angelegenheit oder kindisches Verhalten haben dich in diese Lage gebracht.","ergebnis_und_wann":"Das Ergebnis ist noch nicht spruchreif und daher wenige zufriedenstellend. Zeit: sehr bald"},"14":{"gendanken":"Alles, was du zu diesem Thema auch denken magst, ist falsch. Entweder ein genereller Denkfehler oder dein Denken führt gänzlich in eine falsche Richtung.","rat_der_engel":"Schau nicht danach, was andere haben oder sagen, tu genau das, was dein Herz dir sagt!","warnung":"Versuche nicht, dein Ziel mit allen Mitteln durchzusetzen. Irgendwann kommt die Stunde der Wahrheit und dann könnte es böse enden.","wo_es_herkommt":"Falsche Gedanken und/oder Absichten haben diese Situation hervor gebracht.","ergebnis_und_wann":"Es ist fraglich, ob du dir dieses Ergebnis auch so vorgestellt hast. Wenn nicht, schau was du beim nächsten mal anders machen kannst. nachts, im Dezember"},"15":{"gendanken":"Schau, ob deine Gedanken zu diesem Thema wirklich hilfreich sind oder eventuell eine Nummer zu groß für diese Angelegenheit!","rat_der_engel":"Reize nie einen Kuschelbären, er könnte zur Bestie werden. Fordere das Schicksal nicht ohne Not heraus.","warnung":"Überschätze dich nicht. Auch wenn du schon viel erreicht hast, prahle nicht, das könnte Neid und Mißgunst auf den Plan rufen, die das Vorhaben vereiteln könnten.","wo_es_herkommt":"Der Grund für diese Situation liegt in alten Verletzungen, an die du vielleicht lange nicht mehr gedacht haben magst, die aber um so kräftiger wirken können. Jetzt bekommst du die Chance, das zu lösen.","ergebnis_und_wann":"Es wird gelingen und als Vorhaben mit Erfolg gekrönt sein. Du strahlst vor neuen Selbstbewußtsein und kannst zurecht stolz auf dich sein. Wann: Im Winter."},"16":{"gendanken":"So wie du über deine Welt denkst, wird sie sich auch zeigen. Achte also darauf, um dich selbst zu schützen. Und denke immer daran: In jedem Mißgeschickt liegt noch etwas Schönes für dich versteckt.","rat_der_engel":"Greife nur nach den Sternen, wenn du sie auch willst. Vor der Dämmerung ist es immer am finstersten!","warnung":"Verliere dich nicht in deinen Träumen, achte darauf, diese auch in die Tat umzusetzen. Es gibt immer etwas zu tun auf dem Weg zur Erfüllung.","wo_es_herkommt":"Was du zuvor als Hilfeleistung und Unterstützung in die Welt gegeben hast, kommt nun als 3faches Glück zu dir zurück und überstrahlt alle negativen Karten.","ergebnis_und_wann":"Plant man etwas Neues zu beginnen, so steht es unter einem guten Stern. Ein Treffen kann ergreifend, romantisch, wundervoll und mystisch werden. Wann: abends, nachts, im Winter."},"17":{"gendanken":"Deine Gedanken und Gefühle sind häufigen Wechseln unterworfen; von himmelhoch Jauchzend bis zu Tode betrübt.","rat_der_engel":"Veränderungen erweitern deinen Horizont und erhöhen die Lebenserfahrung.","warnung":"Reagiere nicht starr und unflexiebel! Akzeptiere die neue Situation und mach das Beste daraus!","wo_es_herkommt":"Menschen ändern sich nicht, sie werden meist nur mehr vom gleichen. Vielleicht hast du zu sehr versucht, (positiv) auf jemanden oder etwas einzuwirken, um eine Veränderung der Situation zu erzielen.","ergebnis_und_wann":"Im Ergebnis wirst du erkennen, dass nur du dich ändern kannst. Hast du den Garten voller Disteln und kannst sie nicht los bekommen, lerne Disteln zu lieben. Im Februar oder August."},"18":{"gendanken":"Dein Verstand ist sehr wachsam, acht darauf, dass du ihn nicht überspannst.","rat_der_engel":"Freunde in der Not gehen hundert auf ein Lot. (Sprichwort)","warnung":"Gehe mit Freundschaften nicht leichtsinnig um. Such deine Freunde sorgfältig aus, man findet sie nicht wie Sand am Meer.","wo_es_herkommt":"Selbstlosigkeit in der Vergangenheit wird sich nun in dieser Situation als hilfreich erweisen. Mangelnde Hilfsbereitschaft in der Vergangenheit fortert hingegen seinen Preis.","ergebnis_und_wann":"Das Ergebnis bringt dir eine gute Stabilität und Sicherheit zurück. Es geht gut aus. Im Juli und dann für eine lange Zeit."},"19":{"gendanken":"Du machst dir sehr viele Gedanken um die Lebensumstände; um deine eigenen und um die der Menschen, die dir am wichtigsten sind.","rat_der_engel":"Einsamkeit ist der Weg, auf dem das Schicksal den Menschen zu sich selbst fuehren will.","warnung":"Verschliesse dich nicht vor deinem sozialen Umfeld und den Regeln, die dort vorherrschend sind. Versuche eher, die Dinge von einem hoeheren Standpunkt aus zu betrachten.","wo_es_herkommt":"Die Ursachen liegen in deiner fruehkindlichen Praegung. Sie sind in deinem Elternhaus und den Erfahrungen aus deiner Schulzeit begruendet. Sie liegen also recht weit zurueck, sind allerdings noch immer aktiv in deiner Energie.","ergebnis_und_wann":"Vielleicht hast du noch nicht bedacht, dass du mit einer neuen Sicht auf die Dinge auch Altes aus den Augen verlierst. In einem Tag, einer Woche, einem Monat oder einem Jahr."},"20":{"gendanken":"Du denkst sehr oft darueber nach, was andere Menschen ueber dich denken moegen.","rat_der_engel":"Was einer nicht oeffentlich tun darf, das soll er auch nicht heimlich tun!","warnung":"Verhalte dich diplomatisch, hoere dir die Meinung anderer Menschen genau an, ohne gleich deine eigene Meinung aufzugeben.","wo_es_herkommt":"Diesmal liegt die Ursache ausserhalb von dir. Vielleicht hast du zu viele Neider oder dir wird zu wenig zugetraut, all das behindert dich im Erreichen deiner Ziele.","ergebnis_und_wann":"Kann sein, es schlaegt so ein, wie eine Bombe, dass wir in der Zeitung davon lesen; auf jeden Fall ist es so erstaunlich, dass wir davon hoeren, weil viele davon reden. Wann: 3 Wochen - 3 Monate."},"21":{"gendanken":"In deinen Gedanken neigst du dazu, aus einer Muecke einen Elefanten zu machen. Nicht alles ist immer so gross oder so unueberwindbar, wie es im ersten Moment zu sein scheint.","rat_der_engel":"Nur wer einen Berg erklommen hat, weiss wie gross die Freiheit ist. An der Hoehe des Berges erkennen wir die Groesse einer Aufgabe.","warnung":"Lass dich von der Groesse der Situation oder des Projektes nicht einschuechtern, du hast mehr Kraft in dir, als du denkst. Auch wenn du den Kopf in den Sand steckst, wird der Berg auf dich warten.","wo_es_herkommt":"Hier sind als Ursache deine eigene Sturheit und Unflexibilitaet zu nennen. Auch wenn du es vielleicht nicht gerne hoerst, hast du jetzt die Moeglichkeit, das zu beheben.","ergebnis_und_wann":"Aus diesem Hindernis erwachsen neue Herausforderungen, weil du sie schon erwartest. Wann: im Januar."},"22":{"gendanken":"Deine Gedanken drehen sich um die Entscheidungen in deinem Leben, die jetzt getroffen werden muessen. Es stehen einige Alternativen zur Wahl.","rat_der_engel":"Jede neue Situation bedarf einer neuen Entscheidung. Wer viel wandert, sieht viele Landschaften.","warnung":"Entscheidungen muessen eben getroffen werden. Weigerst du dich, veraenderst du den Lauf der Dinge zu deinen Ungunsten.","wo_es_herkommt":"Es war deine eigene Entscheidung, die dich in diese Situation gebracht hat. Auch wenn es vielleicht nicht so ausgesehen hat, man hat immer eine Wahl.","ergebnis_und_wann":"Am Ende wird es fuer einiges mehr gut sein, als nur fuer das Ergebnis, das offensichtlich ist. Du wirst ueberrascht sein. Wann: innerhalb von 2 Monaten."},"23":{"gendanken":"Denken ist immer anstrengend und verbraucht eine Menge Energie. An Sorgen und Zweifel denken verbraucht noch einmal so viel.","rat_der_engel":"Nur wer nicht loslassen kann, wird einen Verlust erleiden.","warnung":"Lass dich nicht entmutigen, wenn auch zur Zeit alles schief zu gehen scheint. Behalte dein Ziel im Auge.","wo_es_herkommt":"Ein schmerzlicher Verlust in der Vergangenheit ueberschattet die momentane Situation.","ergebnis_und_wann":"Das Ergebnis wird dich wenig zufriedenstellen; vielleicht wirst du sogar enttaeuscht sein. Es verzoegert sich noch eine ganze Weile."},"24":{"gendanken":"Momentan siehst du alles durch eine rosarote Brille.","rat_der_engel":"Durch die Liebe wird all das leichter, was der Verstand als gar zu schwer erachtet.","warnung":"Wenn du auf dein Herz hoerst, kann nichts mehr schief gehen. Benutze dennoch ab und an deinen Verstand.","wo_es_herkommt":"Vielleicht hast du an das Gute im Menschen geglaubt und vielleicht auch noch dann, als es offensichtlich schief ging. Diese Gutglaeubigkeit hat dich in diese Situation gebracht.","ergebnis_und_wann":"Du wirst mit dem Ergebnis sehr, sehr zufrieden und gluecklich sein. Alles kommt, wie du es wuenscht. Wann: im August."},"25":{"gendanken":"Deine Gedanken drehen sich die meiste Zeit um deine Verpflichtungen; oder um das, was du fuer deine Verpflichtungen haelst.","rat_der_engel":"Eine Ehe ist kein Fertighaus, sondern ein Gebaeude, an dem staendig konstruiert und repariert werden muss.","warnung":"Mit Versprechen und Ehrenwoetern sollte man sparsam umgehen. Mach nur dann eine Zusage, wenn du sie auch wirklich einhalten kannst (oder willst) und sei kooperativ.","wo_es_herkommt":"Ein uraltes Versprechen wird nun eingefordert.","ergebnis_und_wann":"Das Ergebnis wird eine feste Beziehung zu jemandem oder etwas zur Folge haben. Du wirst fuer laengere Zeit daran gebunden sein. Es wird noch eine Weile dauern, man dreht sich im Kreis."},"26":{"gendanken":"In deinen Gedanken zweifelst du oft, ob du auch alles richtig bedacht hast und versuchst, alles im Kopf und ganz allein zu loesen. Vielleicht versuchst du auch, ein Geheimnis zu bewahren oder zu loesen.","rat_der_engel":"Wissen ist ein Schatz, der seine Besitzer ueberall hin begleitet.","warnung":"Geheimnisse sollten vertraulich behandelt werden. Wenn du etwas wichtiges erfahren willst, sei geduldig. Es kommt zu dir zu der rechten Zeit.","wo_es_herkommt":"Ein Geheimnis wurde preisgegeben oder es fehlen noch wichtige Informationen, so dass es zu dieser Situation kommen konnte.","ergebnis_und_wann":"Zu diesem Zeitpunkt ist ein Ende noch nicht abzusehen. Auch das Wann ist noch verborgen."},"27":{"gendanken":"Deine Gedanken drehen sich um einen bestimmten Menschen oder um eine wichtige Angelegenheit und vielleicht wartest du schon sehnsuechtig auf eine Nachricht.","rat_der_engel":"Ein beschriebenes Blatt Papier kann mehr wert sein, als tausende von Goldbarren.","warnung":"Verschliesse dich nicht vor deinen Kontakten und nimm dir mal wieder Zeit fuer ein Telefonat oder einen lieben Brief. Es gibt jemanden in deiner Naehe, der schon auf deine Nachricht wartet.","wo_es_herkommt":"An einem bestimmten Punkt in deiner Vergangenheit hast du versaeumt, auf eine Situation angemessen zu reagieren. Das Ergebnis davon hast du jetzt. Eine Nachricht wurde zu wenig beachtet.","ergebnis_und_wann":"Du erhaeltst eine Nachricht in dieser Angelegenheit. Wann: in wenigen Tagen."},"28":{"gendanken":"Du hast etwas oder jemanden bestimmten im Sinn und bist bereit, den ersten Schritt in die richtige Richtung zu gehen... auch wenn du noch nicht so ganz genau weisst, wie der ausschaut.","rat_der_engel":"Man sollte sich selbst nie als Mass aller Dinge betrachten.","warnung":"Vielleicht nimmst du dich selbst oder deine Ansichten etwas zu wichtig... denke daran: Hochmut kommt vor dem Fall!","wo_es_herkommt":"Eventuell ein unabgeschlossenes Thema mit deinem Vater oder einer vaeterlichen Person, einem vaeterlichen Freund waehrend deiner Kindheit.","ergebnis_und_wann":"Du wirst gezwungen sein, ins Handeln zu kommen, denn von nichts kommt nichts. Wann: am Nachmittag, im Herbst."},"29":{"gendanken":"Du gruebelst zu viel und machst dir um jemanden oder etwas einfach zu viele Sorgen.","rat_der_engel":"Sich selbst sollte man nicht vernachlaessigen - andere aber auch nicht.","warnung":"Vielleicht stellst du dich selbst zu sehr in den Vordergrund, bist nicht in deiner Mitte oder vernachlaessigst zu sehr deine eigene Persoenlichkeit. Achte mehr auf dich.","wo_es_herkommt":"Dieses ist eine Variante der Auseinandersetzung mit deiner Mutter. Sicher hast du schon das ein oder andere Mal eine aehnliche Situation durchlebt, jetzt hast du die Moeglichkeit, dieses Thema zu klaeren.","ergebnis_und_wann":"Sei bereit, das Ergebnis, die endgueltige Situation so hinzunehmen, wie sie kommt. Wann: im Mai."},"30":{"gendanken":"Heisse und hoch erotische Gedanken schleichen sich mehr und mehr ins Alltagsgrau. Du geniesst Tagtraeumereien und entfliehst damit der Langeweile.","rat_der_engel":"Lebensklugheit bedeutet, alle Dinge moeglichst wichtig, aber keines allzu ernst zu nehmen.","warnung":"Zerstoere nicht die Harmonie, die dich umgibt, nur um Recht zu behalten. Im Zweifel hol dir Rat bei einer klugen Person.","wo_es_herkommt":"Eine alte Affaere oder nicht abgeschlossene Angelegenheit ist der Grund fuer diese Situation. Vielleicht hast du noch nicht alles gelernt, was du lernen koenntest.","ergebnis_und_wann":"Das Ergebnis wird dich erfreuen. Es zeigt dir, dass du geachtet wirst und Aufmerksamkeit erhaeltst. Du bekommst Hilfe, Unterstuetzung und positive Umstaende. Wann: im Winter"},"31":{"gendanken":"Du denkst recht positiv ueber diese Angelegenheit, bzw in die richtige Richtung. Diese Gedanken bringen dir deine Energie zurueck und staerken und naehren dich.","rat_der_engel":"Die Sonne ist die Universalarznei aus der Apotheke Gottes.","warnung":"Zu viel des Guten kann auch schaedlich sein. Manchmal macht es uns unvorsichtig und wir holen uns einen Sonnenbrand. Ruh dich nicht auf deinen Lorbeeren aus, und tu etwas, um deinen Status zu halten.","wo_es_herkommt":"In der Vergangenheit hast du fuer jemanden etwas unglaublich Gutes getan und diese Tat bringt dir nun 3faches Glueck zurueck.","ergebnis_und_wann":"Das Ergebnis wird dich und andere in Erstaunen versetzen, so toll! Das Glueck kehrt in dein Leben zurueck und ueberstrahlt alle negativen Aspekte. Bei kurzfristigen Dingen zur Mittagsstunde, ansonsten im Sommer."},"32":{"gendanken":"Achte darauf, dass deine Gedanken dich nicht zu sehr runter ziehen, vielleicht weil dir die Aufgabe zu gross erscheint oder aus Angst, dass du nicht gut genug sein koenntest oder es nicht schaffen wirst.","rat_der_engel":"Jeder Gedanke, den wir in unserem Geist entwickeln, strebt danach, Wirklichkeit zu werden und sich durch das Gesetz der Anziehung zu materialisieren.","warnung":"Das was wir sehen, denken und fuehlen bestimmt unser Leben. Achte auf dein Bauchgefuehl, es hat meistens recht.","wo_es_herkommt":"Die Ursache fuer dieses Thema, die wirkliche Ursache, liegt tief in deiner Seele verborgen. Und so zeigt sie sich als Situation, um gesehen und geloest zu werden. Streben nach Aufmerksamkeit.","ergebnis_und_wann":"Du erntest viel Ruhm und Anerkennung, wenn der Mond auf das Ergebnis strahlt, wie ein Scheinwerferlicht. In jedem Falle bekommst du die Aufmerksamkeit, die du dir wuenscht. In 4 Wochen (28 Tage)."},"33":{"gendanken":"Du ahnst es sicher schon: Du bist der Loesung fuer deine Aufgabe gedanklich schon sehr, sehr nahe. Stell deinem Universum die richtigen Fragen: Was kann ich (noch) tun, um...? Wie kann ich mein Ziel erreichen? usw.","rat_der_engel":"Mit dem richtigen Schluessel steht dir das ganze Universum offen! Wenn du ein Ziel wirklich erreichen willst, dann tu einfach so, als wenn ein Scheitern unmoeglich ist. Dann hilft dir das ganze Universum!","warnung":"Geh nicht davon aus, dass du jetzt den Schluessel fuer alles und fuer jeden in der Hand hast. Wenn du dich zu arg auf das Loesen von Aufgaben konzentrierst, schickt dir das Universum mehr Aufgaben zum Loesen.","wo_es_herkommt":"In der Vergangenheit wurde durch Machtausuebung eine Wendung der Ereignisse erwirkt. Das fordert jetzt deine ganze Aufmerksamkeit.","ergebnis_und_wann":"Es wird ganz sicher gelingen. Was du auch vor hast, der Erfolg gehoert schon dir. Du musst einfach nur diesen Weg zuende gehen. Wann: Es ist an der Zeit, sich jetzt zu oeffnen. In jedem anderen Fall: im November."},"34":{"gendanken":"Deine Gedanken sind sehr tiefgruendig, wenn es um dieses Thema geht, aber nicht immer auch ebenso hilfreich, sie bringen dir nur immer mehr von diesen Gedanken hervor.","rat_der_engel":"Wahrer Reichtum kommt von innen. Worauf du deine Aufmerksamkeit richtest, das wird mehr in deinem Leben.","warnung":"Auch wenn alles, was du dir wuenscht im Ueberfluss vorhanden zu sein scheint, sei massvoll mit deinen Gefuehlen und entwickle mehr Dankbarkeit.","wo_es_herkommt":"Die Ursache liegt tief in der Seele... oder im Alkohol. Gib in jedem Falle besser auf dich acht.","ergebnis_und_wann":"Das Ergebnis droht ins Wasser zu fallen, dennoch wird es sich letzlich als grosser Gewinn herausstellen. Wann: im Februar."},"35":{"gendanken":"In Gedanken drehst du dich im Kreis und bleibst doch immer an der selben Stelle haengen. Lass los.","rat_der_engel":"Wehe dem, der keine Heimat hat. Und das ist die Sehnsucht, wohnen im Gewoge und keine Heimat haben in der Zeit. Rilke","warnung":"Achte darauf, nicht zu starr und unflexibel zu sein. Auch wenn dir deine jetzige Situation Sicherheit zu versprechen scheint, lerne loszulassen und zu neuen Ufern aufzubrechen.","wo_es_herkommt":"Vielleicht bist du selbst in deiner Persoenlichkeit in manchen Situationen einfach zu anhaenglich.","ergebnis_und_wann":"Jemand oder etwas kommt in den Heimathafen zurueck. Wann: im September."},"36":{"gendanken":"So selbstzerstoererische und mitleidige Gedanken, wie: Warum immer ich? Koennen sich jetzt in dein Bewusstsein schieben. Gib dem in keinem Fall nach!","rat_der_engel":"Jeder hat sein Kreuz zu tragen. Einer trage des anderen Last.","warnung":"Lerne aus deinen Fehlern und nimm sie als wertvolle Erfahrung an. Dieser Aspekt nimmt an Bedeutung ab.","wo_es_herkommt":"Es ist ein sehr altes, karmisches Band, das dich in diese Situation hinein gefuehrt hat und sich jetzt nach Erloesung sehnt.","ergebnis_und_wann":"Gott wuerfelt nicht! - jedenfalls nicht so oft. Es wird ein schicksalhaftes Ergebnis. Wann: 2-3 Wochen"}};
const COMBOS={"1-2":"Eine frohe Botschaft erreicht dich bald.","1-3":"Durch diese Neuigkeit wirst du etwas oder jemanden besser verstehen können und toleranter sein.","1-4":"Eine Nachricht, meist positiver Natur, kommt dir ins Haus.","1-5":"Eine Nachricht braucht länger als erwartet, um dich zu erreichen.","1-6":"Diese Neuigkeiten sind nicht ganz so gut, wie erhofft.","1-7":"Ein Anruf von deiner Mutter (oder einer guten Freundin) bringt guten Rat und Licht ins Dunkle.","1-8":"Du hattest erwartet, zu erfahren dass sich endlich etwas tut, dass es voran geht; aber es bleibt leider noch alles beim Alten.","1-9":"Es kommt bald Besuch, der die Situation erhellen kann.","1-10":"Du bekommst eine Absage. Auch wenn es sich schmerzlich an fühlt, wird es letztlich zu deinem Besten ausgehen.","1-11":"Es kommt eine Nachricht, eine Idee oder ein neues Projekt, das Grund zu Diskussionen gibt.","1-12":"Diese Nachricht, diese Idee oder Projekt wird dich in Schwierigkeiten bringen. Halte durch, der Stress geht schnell vorüber.","1-13":"Ein Wunsch geht bald in Erfüllung, du erfährst jetzt mehr darüber.","1-14":"Eine Nachricht trifft ein, die du sehr genau prüfen solltest, bevor du sie für wahr nimmst.","1-15":"Es erreicht dich eine Nachricht von offizieller Seite. Ein Behördenbrief erreicht dich. Du erhältst Nachricht von deinem Chef. Wenn du ein Zeugnis erwartest, wird es hervorragend ausfallen. Du erhältst (brauchst?) ein großes Auto zu repräsentativen Zwecken.","1-16":"Eine neue Idee, ein großes Projekt beginnt nun Formen anzunehmen. Vielleicht beginnst du dadurch noch einmal ganz von vorne. Die erlösende Nachricht erreicht dich.","1-17":"Diese Nachricht ändert alles. Schwarz wird weiß, alt wird neu und Nacht wird Tag.","1-18":"Ein Freund eilt dir zur Hilfe. Manchmal müssen wir nur darauf hinweisen, dass wir Hilfe brauchen. Frage einen Freund um Rat.","1-19":"Post vom Amt erreicht dich. Ein Steuerbescheid vielleicht, ein Rentenbescheid, ein Brief deines Rententrägers darüber, wie viel Rente du voraussichtlich bekommen wirst. Diese Nachricht sollte dich wach rütteln, selbst etwas zu tun. Post vom Amt, vielleicht die Befürwortung einer Reha, vielleicht ein Bußgeldbescheid? Der Reiter +","1-21":"Die guten Nachrichten haben dich nur noch nicht erreicht. Vielleicht wartest du zu sehr auf eine Nachricht. Du weißt es ja schon, was wir uns zu sehr wünschen, erreichen wir nur schwer.","1-22":"Wenn du vielleicht noch denkst, dass du eine Wahl hast, haben andere oder jemand anderes schon für dich entschieden.","1-23":"Diese Nachrichten werden dir Kummer bereiten. Das Auto ist defekt. Eine Veranstaltung, die du vielleicht mit Freunden besuchen wolltest, kann ausfallen oder verschoben werden. Gute Nachrichten erreichen dich nicht. Jemand, der für eine Situation wichtig ist, ist verhindert.","1-24":"Diese Nachrichten bringen dich der Erfüllung deines Herzenswunsches noch ein Stück näher. Neue Ideen und Projekte treffen auf offene Ohren und begeisterte Zuhörer.","1-25":"Es ist endlich soweit, die Einladung zur Vertragsunterzeichnung ist gekommen. Es kann sich also auch um eine Einladung zu einem Vorstellungsgespräch sein. Wenn es so sein soll, erhältst du schon ganz bald einen Heiratsantrag. Das Auto ist verkauft. Ein neues Projekt wird in Angriff genommen.","1-26":"Du erfährst von einem Geheimnis. Diese Nachricht wurde geschickt formuliert.","1-27":"Die Nachricht befindet sich noch auf dem Postweg, in der Post. Dokumente und Papiere müssen übergeben, bzw vorgelegt werden. Fahrzeugpapiere werden zugeschickt, überreicht und das Auto endlich zugelassen. Wenn das Telefon klingelt erreichen dich fröhliche Nachrichten, und du kannst auf gute Neuigkeiten hoffen.","1-28":"Als Person: Er ist ein sehr aktiver, sportlicher junger Mann. Vielleicht mag er besonders den Reitsport oder er fährt gerne mit dem Auto durch die Gegend. Das Auto ist ihm schon sehr wichtig. Als Situation: Diese Nachricht ist sehr persönlich und bringt dich in Bewegung. Sie wird dir unter die Haut gehen und dich als bald in Bewegung bringen.","1-29":"Als Person: Eine sportliche junge Frau, die gerne plaudert oder viel in sozialen Netzwerken präsent ist, gerne chatet usw. Als Situation: Es erreicht dich eine vertrauliche Nachricht, die du für dich behalten solltest. Es kann sich auch um Komplimente handeln, die du gerne annehmen solltest.","1-30":"Du erhältst Nachrichten von deinem Geliebten. Die vielleicht noch harmlosen, freundlichen Nachrichten könnten sich bald zu einem handfesten Flirt entwickeln.","1-31":"Diese Nachricht ist überaus positiv. Es erreichen dich schon bald überragende Neuigkeiten. Du hörst von einem großen Erfolg.","1-32":"Diese Nachricht kündet großen Ruhm und Anerkennung an. Du erfährst davon, dass jemand endlich mal begriffen hat, wie viel du für diesen Menschen oder diese Situation getan hast.","1-33":"Diese Nachricht erreicht dich auf jeden Fall. Er wird sich wieder bei dir melden. Du hältst einen Autoschlüssel in deiner Hand.","1-34":"Du solltest deinen Lottoschein auch abgeben oder ein Los kaufen. Diese Nachricht bringt dich auch finanziell wieder in gute Stimmung. In jedem Falle kommen die Dinge jetzt wieder in Bewegung und Schwung in die Angelegenheit.","1-35":"Du bekommst eine Nachricht von deiner Arbeit. Ein besonderes Thema lässt dich nicht los und durch diese Nachricht erhält es neue Nahrung.","1-36":"Diese Nachricht wirkt sich auf alle Ebenen deines Lebens aus. Eine schicksalhafte Nachricht erreicht dich. Eine Begegnung mit einem jungen Mann verändert dein Schicksal.","2-3":"Wenn du einen Kurzurlaub planst, solltest du bei den Last Minute- Angeboten nach schauen, du wirst dort ein überaus verlockendes Angebot finden. In dieser Situation ist es hilfreich, Verständnis zu zeigen. Das bringt das Glück zurück und Toleranz wird belohnt.","2-4":"Wenn du auf Wohnungssuche bist, erweist sich die angebotene Wohnung als absolutes Schätzchen. Glück kehrt in dein Haus zurück, wenn es zuvor etwas schwierig war und ihr seit beschützt. Wenn das Glück sowieso ständiger Gast in deinem Haus ist, so kannst du es durch Dankbarkeit in deinem Hause halten.","2-5":"Die Zeit ist reif und das Glück zum Greifen nah. Wenn eine Situation gerade anstrengend war und vielleicht auch lang andauerte, so kehrt nun innerhalb kurzer Zeit das Glück zurück.","2-6":"Dein Glück scheint getrübt zu sein. Konzentriere dich auf die positiven Aspekte dieser Situation.","2-7":"Vielleicht suchst du dein Glück an den falschen Stellen und Verwicklungen bringen nur noch mehr Aufregung. Frag Mutti (oder eine gute Freundin) um Rat, sie hat bedeutend mehr Lebenserfahrung und einen anderen Blick auf die Situation.","2-8":"Das Glück versteckt sich in einer Kiste, du musst es nur finden! Diese glückliche Phase kann ein jähes Ende finden. Du wirst vor dunklen Energien geschützt.","2-9":"Das Leben birgt viele Geschenke, wenn du sie annimmst, wirst du überrascht sein. Kleine Geschenke erhalten die Freundschaft. Du wirst zu einer Party eingeladen und es könnte aufregend werden.","2-10":"Auch wenn es jetzt noch nicht so aussehen mag, das Glück kommt plötzlich und unerwartet zurück. Dieses Glück hast du dir redlich verdient.","2-11":"Angenehme Gespräche und anregende Unterhaltungen erwarten dich. Vielleicht ein Mädelsabend? Ein Abend unter Freunden. Wenn du einen Streit hattest, ist jetzt eine gute Zeit zur Versöhnung. Du kannst von Glück reden, wenn diese Worte nicht gar so tiefe Wunden hinterlassen haben. Ein bevorstehendes Gespräch, eine Aussprache verläuft besser als erwartet.","2-12":"Du bekommst einen Anruf, eine SMS oder E-Mail die dich aufregen werden. In diesem Fall positiver Natur.","2-13":"Wenn du etwas Neues beginnen möchtest, einen Neuanfang wagen willst, dann ist jetzt der Zeitpunkt dafür, den du nicht ungenutzt verstreichen lassen solltest. Unwissenheit und kindliche Naivität schützen in dieser Situation vor schwierigen Situationen.","2-14":"Manchmal ist das Glück tückisch und der Preis dafür sehr hoch. Schau ob du bereit bist, ihn zu zahlen, ansonsten gehe schnell weiter.","2-15":"Glück im Spiel. Gute Leistungen (Noten) bringen dir die nötige Anerkennung. Du hast Glück mit deinem Chef, bei einem Anwalt oder einer autoritären Person. Nutze die Gelegenheit, denn gute Situationen gehen schnell vorüber.","2-16":"Eine plötzliche Eingebung lässt dich einen klaren Blick auf eine Person oder eine Situation erhalten. Eine Idee für ein neues Projekt solltest du unbedingt in Angriff nehmen, es wird sich lohnen und den Erfolg bringen, den du dir wünscht.","2-17":"Veränderungen in den eigenen Ansichten oder eine Situation betreffend bringen jetzt glückliche Zeiten. Veränderungen müssen sein und bringen dir Glück, jetzt bieten sich günstige Gelegenheiten.","2-18":"Du bekommst Hilfe von unerwarteter Stelle. Ein Freund hat gute Ansichten zu diesem Thema, du solltest ihn anhören, es könnte dir Glück bringen.","2-19":"Behördliche Angelegenheiten gehen gut aus. Es ist wichtig, auch einmal Nein zu sagen und deine Grenzen aufzuzeigen. Die daraus resultierende Stärke gibt dir ein gutes Selbstwertgefühl.","2-20":"Du wirst viel Freude daran haben, mehr von dir zu zeigen, auszugehen und das Leben in vollen Zügen zu genießen.","2-21":"Auch große Herausforderungen beginnen mit einem kleinen Schritt! Teile eine große Aufgabe in kleine Abschnitte und gewinne so den Spaß daran zurück.","2-22":"Welche Entscheidung du auch treffen musst, du triffst immer die richtige. In dieser Situation kannst du nichts falsch machen, du Glückspilz!","2-23":"Jede schöne Situation wird von einer anderen abgelöst, wie der Tag von der Nacht. Lass nicht zu, dass diese Tatsache dir die Kraft raubt, dann wird die Sonne bald wieder scheinen. Du musst dein Glück absichern gegenüber Schmarotzern, die versuchen auf deiner Schiene mitzureisen.","2-24":"Du hast Glück in einer Situation, die dir sehr am Herzen liegt. Es wird sich zum Guten wenden, du musst nur richtig hinschauen.","2-25":"Du wirst bald mit jemandem oder zu etwas eine längere Verbindung eingehen, die dich auch glücklich machen wird. Eine schöne Verbindung.","2-26":"Wenn dieses Geheimnis gelöst ist, wirst du die Erleichterung spüren können. Vielleicht ahnst du schon, worum es sich hier handelt.","2-27":"Dieser Anruf, SMS oder E-Mail, bringen dir Glück, fordern aber auch zum schnellen Handeln auf. Greif zu, sonst geht diese gute Gelegenheit ungenutzt vorüber.","2-28":"Als Person: Dieser Herr ist eine Frohnatur, sportlich und spontan. Als Situation: Es kündigt sich ein persönlicher Glücksfall an, auch wenn andere nicht dieser Meinung sind, lass dich nicht beirren.","2-29":"Als Person: Diese Dame ist sehr beliebt, wegen ihrer Fröhlichkeit, sie ist spontan und vergnügt.","2-30":"Unser tägliches Leben hält viel mehr Überraschungen für uns bereit, als wir denken: Halte Ausschau nach dem, was dir gerade am meisten fehlt in deinem Leben: Liebe, Harmonie, Sex, Freude, Anerkennung… es ist dir näher als du denkst.","2-31":"Viel Glück, neue, frische Energie und Lebensfreude erreichen dich bald, auch wenn es vielleicht noch nicht so zu sein scheint, bewahre deine Zuversicht.","2-32":"Ruhm, Ehre und Anerkennung erhält man selten, wenn man darum fragt. Halte einfach an deinen Idealen fest. Tue, was du in deinem Herzen fühlst und plötzlich sind sie da!","2-33":"Du hast den Schlüssel zum Glück gefunden. Das bringt dir Sicherheit für lange Zeit, da du wieder ein Gefühl dafür bekommst, Herr der Lage zu sein.","2-34":"Entweder hast du gerade oder bekommst so bald ein verlockendes Angebot. Greif schnell zu, bevor es ein anderer tut.","2-35":"Vielleicht ist es das Loslassen, das dir dein Glück zurück bringt oder aber das Festhalten an einer Situation. Im Zweifel immer das, was dir am schwersten fällt.","2-36":"Diese Situation ist eine Prüfung des Schicksals und du hast sie schon fast bestanden. Die Situation geht schon sehr bald gut für dich aus.","3-4":"Zurück nach Hause, alles zurück auf Anfang. Manchmal ist es sinnvoll, noch einmal ganz von vorne zu beginnen. Innerhalb der Familie kehrt wieder Ruhe ein, wenn die Zeiten turbulent waren. Ein tieferes Verständnis stellt sich ein. Dies könnte der Beginn eines Familienunternehmens sein. Wenn die Familie sich einig ist, kann sie ihren Einflussbereich vergrößern. Dabei kann es sich durchaus auch um eine Wahlfamilie handeln.","3-5":"Um dein Ziel zu erreichen wirst du noch eine Menge Geduld aufbringen müssen.","3-6":"In dieser Situation geht es mehr um das gegenseitige Verstehen des Standpunktes in einem Problem, als um dessen Lösung. In Bezug auf eine Situation oder ein bestimmtes Thema sind nicht alle Aspekte deutlich zu erkennen. Achte darauf, vorsichtig voran zu schreiten und auf alle Eventualitäten gut vorbereitet zu sein.","3-7":"Nicht immer ist der kürzeste Weg der, auf dem man am schnellsten voran kommt. So wie jedes Leben ist auch deines eine Reise und momentan bist du dabei, einige Umwege zu fahren, um letztlich doch an dein Ziel zu kommen.","3-8":"Du wolltest dich doch auf den Weg machen um etwas oder jemanden bestimmtes zu erreichen, worauf wartest du dann noch? Gehe jetzt los!","3-9":"Die nächsten Schritte führen dich vielleicht noch nicht ganz an dein Ziel, aber sie bringen dich einen bedeutenden Schritt weiter und das ist ein Grund zum Feiern. Vielleicht erhältst du auch eine Einladung zur Teilnahme an einem größeren Projekt oder einem Seminar, das in einiger Entfernung stattfindet.","3-10":"Bereite dich gut vor, bevor du die nächsten Schritte unternimmst, für diese Situation oder dieses Thema ist es wichtig, alle Sinne zusammen zu halten. Für einen plötzlichen Kurswechsel ist die Situation oder die Einstellung dazu nicht flexibel genug.","3-11":"Größere Unternehmungen könnten jetzt auf Widerstand stoßen. Es ist besser, wenn du erst einmal loslegst und dann über die Einzelheiten redest. Im Zweifel ist es immer besser, sich hinterher zu entschuldigen, als zuvor um Erlaubnis zu bitten.","3-12":"Wenn ein Seemann die Möwen erblickt, weiß er, dass bald Land in Sicht ist. Du kannst beruhigt sein, es geht bald weiter. Schneller noch, wenn du aufhörst, dir selbst den Wind aus den Segeln zu nehmen. Du hast dein Ziel fast erreicht.","3-13":"Auch wenn du dein Ziel unbedingt erreichen willst und dich zielstrebig auf den Weg gemacht hast, solltest du offen für neue Impulse sein. Sie sind nicht nur erfrischend anders, sondern können auch mehr Spaß und Lebensfreude ins Streben bringen.","3-14":"Was sind deine wirklichen Motive? Verfolgst du dein Ziel aus einem Herzenswunsch heraus oder weil es vernünftig ist? Denke darüber nach und entscheide dich neu. Bei einem Handel könntest du übervorteilt werden, weil du vielleicht zu gutmütig bist oder immer an das Gute im Menschen glaubst. Halte dich an jemanden, der weniger Mühe damit hat, Nein zu sagen.","3-15":"Große Taten werden von dir abverlangt. Manchmal liegt das Große auch in kleinen Gesten. Handle jetzt! Lass dich bei Verhandlungen nicht von deinem Gegenüber einschüchtern, du bist ihm mindestens ebenbürtig, auch wenn du es dir nicht vorstellen kannst.","3-16":"Wenn du etwas oder jemanden erreichen möchtest, stehen die Sterne jetzt günstig und du wirst Erfolg haben.","3-17":"Warum in die Ferne schweifen… ? Auch wenn du am liebsten ganz weit weg möchtest, nimmst du dich selbst doch immer mit.","3-18":"Ein Freund von weiter her, vielleicht sogar aus dem Ausland, wird in dieser Situation sehr wichtig für dich sein. Es ist gut, an seinen Zielen treu und offenherzig festzuhalten. Auch wenn es nicht so zu sein scheint, es gibt Grund zur Hoffnung.","3-19":"Vielleicht willst du aus der Situation aussteigen, weil dir alles zu viel zu werden scheint; vielleicht willst du es aber auch alleine regeln, weil du dann weißt, dass es dann wenigstens “richtig” gemacht wird. Beides ist in Ordnung, wenn es dich nicht überlastet.","3-20":"Dein Handeln wird von vielen Leuten wahrgenommen, vielleicht sogar von mehr Menschen, als dir lieb ist. Bleib integer.","3-21":"Diese Reise (auch im übertragenen Sinne) wird beschwerlich, denn die Wasser fließen selten bergauf. Geduld und Beharrlichkeit führen zum Ziel.","3-22":"Vielleicht hast du dir selbst den Wind aus den Segeln genommen, weil du dich weder für die eine noch für die andere Richtung entscheiden möchtest. Suche nach einer dritten Möglichkeit, dann geht es schneller voran.","3-23":"Mäuse finden wir nur da, wo es auch was zu naschen gibt. Sei nicht so großzügig im Umgang mit deinen Ressourcen, sonst stehst du am Ende mit leeren Händen da.","3-24":"Jetzt oder schon recht bald ist es Zeit, das Erreichte zu genießen. Du kannst dich zurück lehnen und in eine fröhliche, liebevolle Zeit zu segeln. Du beschäftigst dich mit den Dingen, die dir Freude bereiten und dir und anderen das Herz höher schlagen lassen.","3-25":"Wenn du einen Urlaub unternehmen willst, könnte eine Clubreise die beste Wahl sein oder vielleicht auch eine Kreuzfahrt. Wenn dir die nötigen Mittel fehlen, erreichen sie dich bald. Das Geschäft wird abgeschlossen, der Handel ist perfekt, der Vertrag wird unterzeichnet.","3-26":"Entweder du selbst oder das Schicksal machen noch ein Geheimnis um die nächsten Schritte. Du wirst ein Buch kaufen, dass dir in dieser Situation sehr hilfreich ist und dir helfen wird, dein Problem zu lösen.","3-27":"Diese Post, Nachricht, SMS oder E-Mail, bringt deine Unternehmung richtig in Fahrt. Du hast dich gut vorbereitet und kannst nun loslegen und dein Ziel in Angriff nehmen.","3-28":"Als Person: Dieser Herr ist viel auf Reisen, vielleicht ist er ein Handelsvertreter oder ein Seemann sogar, vielleicht fährt er aber auch einen LKW. Achtung vor zu viel Seemannsgarn. Als Situation: Du musst schon selbst aktiv werden, um die Dinge voran zu bringen. Jetzt kommen gute Gelegenheiten auf dich zu.","3-29":"Als Person: Diese Dame lässt die Dinge gerne auf sich zukommen und wartet ab, was sich daraus ergibt. Als Situation: Um erfolgreich zu sein wirst du abwarten müssen, bis sich die Dinge von selbst entwickeln, um dann das beste daraus zu machen.","3-30":"Ein leidenschaftliches Abenteuer wartet auf dich, du steuerst direkt darauf zu. Was du auch tust, im familiären Bereich geht es harmonisch zu und wird es auch bleiben, das gibt dir Kraft und Sicherheit. Das sind genau die Eigenschaften, die du bald brauchen wirst.","3-31":"Du hast dein Schiff auf Kurs und stehst souverän und gradlinig bereit, diesen Kurs auch weiter zu verfolgen. Das ist auch gut so, denn du weißt ja schon, dass es dich zu einem großen Erfolg führen wird und alles zum Guten wendet. Im Glanze dieser wundervollen Energie, die dich durchströmt, kannst du leicht mehr Toleranz zeigen und so größere Klippen leicht umfahren.","3-32":"Mit deinem Handeln erntest du Ruhm und Anerkennung. In dieser Angelegenheit solltest du auf deine Intuition vertrauen, sie wird dich leiten.","3-33":"Toleranz ist der Schlüssel für diese Situation. Du weißt es ja vielleicht noch, wie es heißt: Der Klügere gibt nach… Du hast gelernt, dich in schwierigen Situationen gut zu verkaufen, das bringt dir Souveränität und Selbstbewusstsein.","3-34":"Du tust viel, um dich zum Positiven zu verändern, übst dich im positiven Denken und im Ziele erreichen? Wenn das der Fall ist, dann wirst du jetzt feststellen, dass sich dieser angestrebte Wandel jetzt fast von allein vollzieht. Das liegt aber daran, weil du schon so lang geübt hast. Das Leben scheint dich in die Knie zwingen zu wollen, da die schwierigen Situationen immer mehr zu sein scheinen? Das ist nur dann der Fall, wenn deine Engel sich wünschen, dass du deine Sichtweise hinterfragst und vielleicht ein wenig toleranter sein möchtest.","3-35":"Diese Situation hat sich schon lange angebahnt und wird auch noch einige Zeit deine Aufmerksamkeit in Anspruch nehmen. Sie wird sich ausdehnen und immer mehr in dein Bewusstsein gelangen. Um das Problem zu lösen, musst du an dir arbeiten.","3-36":"Diese Reise (auch im übertragenen Sinne) wird sich arg auf dein Schicksal auswirken. Überlege dir die nächsten Schritte gut und denke immer daran: Es gibt nur zwei Arten von Schmerz, den der Herausforderung und den des Bedauerns… Kartenrückseite (Coverbild) - Anna Benoir Mystisches Wicca Lenormand","4-5":"Themen, die dir besonders wichtig sind, kannst du nun mit der notwendigen Reife und Geduld betrachten. Es kann noch eine Weile dauern, ehe sich die Situation in deinem persönlichen Umfeld so klärt, wie du es haben willst. Wenn du nach einem neuen Haus oder einer Wohnung suchst, wirst du sie an dem Grün erkennen, das es umgibt. Das sind die sichersten Zeichen.","4-6":"Familienangelegenheiten klären sich in kurzer Zeit auf. Wenn dir in letzter Zeit etwas sehr nahe ging, löst es sich nun auf. Der Exmann stört den Familienfrieden.","4-7":"Eine Schlange im Haus ist selten ein guter Gast. Achte darauf, dass du etwas oder jemanden nicht überbewertest, das könnte zu Verwicklungen führen.","4-8":"Wenn es nicht voran geht mit dem Thema, das dir am wichtigsten ist, könnte es daran liegen, dass es noch nicht schlimm genug ist. Komm aus deiner Komfortzone heraus und riskiere mal wieder etwas. Etwas hat dich in deinen Grundfesten erschüttert und dir einen gehörigen Schrecken eingejagt. Schlimme Befürchtungen haben die Angewohnheit, auch einzutreffen. Wie damals die Hiobsbotschaften: “Und was ihr fürchtetet kam über euch…”","4-9":"Vielleicht wirst du zu einer Gartenparty eingeladen, zu einem Grillfest oder zu einem Richtfest, ein Fest, das in Bezug zu dem Thema deiner Fragestellung wichtig ist. Wenn du ein neues Haus oder eine neue Wohnung beziehen möchtest, wirst du es mit viel Freude und Kreativität einrichten.","4-10":"Behalte nur das, was dir wirklich wichtig ist und trenne dich von altem, unnötig gewordenen Ballast. Du wirst freier Atmen können, wenn du wieder Raum hast und vielleicht bringt es ja auch noch einen Urlaubsgroschen auf dem Trödelmarkt ein.","4-11":"Bei diesen Diskussionen kann schon mal der Haussegen schief hängen, es geht hoch her. Vielleicht ist es auch das Haus oder die Wohnung an sich Grund für Gespräche und Auseinandersetzungen, ist es zu groß? - zu klein geworden? Fehlt der Balkon oder Garten? Solche Gespräche sollen ernst genommen, allerdings nicht überbewertet werden.","4-12":"Etwas oder jemand zerrt an deinen Nerven und bringt Unruhe ins Haus. Dieser Stress ist aber nur von kurzer Dauer. In der Gegend wird viel getratscht und das weißt du auch. Das kann Ärger geben, du solltest aber darüber stehen.","4-13":"Wenn ihr ein neues Haus oder eine neue Wohnung sucht, werdet ihr es jetzt finden. In die Nachbarschaft zieht eine neue Familie mit Kindern ein. Vielleicht ist das der Beginn einer wundervollen Freundschaft. Der Umbau (oder ein größeres Projekt, das du vor hast) kann jetzt durchgeführt werden. Wenn du einen Wunsch hegst, der für deine Wohnung oder dein Haus bestimmt ist (eine neue Stehlampe, ein Vitamix oder eine neue Küche), so wird er sich jetzt erfüllen.","4-14":"Gerade wenn es um ein neues Haus geht oder um eine neue Wohnung, sollte man sich ein Baugutachten vorlegen lassen, da man sonst vielleicht die Katze im Sack kauft. Die falsche Wohnung, das falsche Haus.","4-15":"In dem Thema, das dir momentan besonders wichtig ist, wirst du dich mit deinen Ansichten, Wünschen und Vorstellungen durchsetzen können. Du bekommst Anerkennung von deinem Chef (einem Vorgesetzten, deinem Vater, älteren Bruder). Du hast Erfolg auf ganzer Linie.","4-16":"Ein lang gehegter Wunsch wird endlich wahr. Das Glück kommt ins Haus zurück. Glückliche Umstände führen dich an dein Ziel. Wenn du denkst, dass dir in dieser Situation nur noch ein Wunder helfen kann, dann wird es dir nun zuteilwerden.","4-17":"Ein Umzug, eine räumliche Veränderung, kann in deiner Situation viel bewirken. Du kannst noch einmal ganz von vorne beginnen. Wenn das Kind oder die Lilie auch noch in der Nähe liegen, kann sich hier durchaus Nachwuchs ankündigen.","4-18":"Ein Nachbar kann in dieser Situation wichtig für dich werden. Du erhältst Unterstützung aus der Nachbarschaft. Vielleicht kann ein kleiner (oder etwas größerer) Hund über die erste Einsamkeit hinweg helfen. Du kämst wieder unter Menschen (beim Gassi gehen) und vielleicht wirst du auch bemerken, dass so ein Wau einen großen Flirtfaktor ergibt.","4-19":"Um der Einsamkeit und der Isolation zu entgehen, solltest du dein Haus öfter verlassen. Frühere Enttäuschungen sollten nicht die Gitterstäbe an deinem Gefängnis sein. Zu Hause geht es momentan um einen Ärger oder eine Auseinandersetzung mit einer Behörde? Jetzt kommt Schwung in die Angelegenheit. Die neue Arbeit, Ausbildung oder das Studium kann jetzt begonnen werden.","4-20":"Wenn du ein großes, öffentliches Haus besuchst, ein Theater vielleicht, ein Kaufhaus, Hotel oder Krankenhaus, könntest du dort wichtige Hinweise für dein aktuelles Thema finden. Vielleicht wartet dort auch schon dein Herzensmann auf dich, wenn du ihn noch suchst. Vielleicht auch eine neue Arbeitsstelle. Geh und halte Ausschau.","4-21":"Die Harmonie und das häusliche Wohlergehen scheinen momentan sehr weit weg. Auch wenn es harte Arbeit bedeuten sollte, mach dich daran, es lohnt sich.","4-22":"Es geht darum, sich für den eigentlichen Lebensmittelpunkt zu entscheiden. Vielleicht führst du schon eine Weile eine Fernbeziehung und es wird langsam anstrengend.","4-23":"Schäden am Haus bringen dich ins Schwitzen. Deine Familie kann sich mitunter zu echten Energieräubern mausern. Achte darauf, einen sinnvollen Ausgleich zu schaffen, damit du wieder zu Kräften kommst. Du musst dringend etwas unternehmen, damit nicht am Ende noch deine Wohnung oder dein Haus verschwinden. Du weißt das auch, warum zögerst du noch?","4-24":"Man kann spüren, wie sehr dein Herz für dein Haus bzw deine Wohnung schlägt. Hier ist der Ort, an dem du Kraft tankst und all deine Akkus wieder aufladen kannst.","4-25":"Das, wofür du dich jetzt verpflichtest, wird dir lange erhalten bleiben. Das solltest du bedenken, wenn du diesen Vertrag unterzeichnest.","4-26":"Hier geht es um ein Familiengeheimnis, das gelöst werden will. Wenn du ein neues Haus oder eine neue Wohnung suchst, solltest du dort nachsehen, wo du bisher noch nicht geschaut hast.","4-27":"Die erwartete Information erreicht dich jetzt. Vielleicht handelt es sich um eine kleine SMS, eine E-Mail, einen Brief oder vielleicht auch nur um eine kurze Information von einem Freund.","4-28":"Als Person: Dieser Herr ist gut situiert. Vielleicht ist er ein Hauseigentümer oder ein Immobilienmakler. Als Situation: Du gibst mehr von dir Preis, als gut für dich wäre.","4-29":"Als Person: Diese Dame ist recht wohlhabend. Vielleicht besitzt sie ein eigenes Haus oder eine eigene Wohnung. Sie ist ruhig und ausgeglichen und sehr angenehm im Umgang. Als Situation: Diese Situation wird von Gastlichkeit dominiert. Zufriedenheit und Wohlergehen kommen ins Leben, wenn man ihnen die Tür aufsperrt.","4-30":"Familienbesuch darf erwartet werden. Vielleicht steht eine Feier bevor. Harmonische Zeiten. Und dein Haus wird von Schönheit und Eleganz erstrahlen. Vielleicht wird aber auch ein junger Liebhaber frischen Glanz in deine Augen treiben.","4-31":"Alles, was du jetzt in Angriff nimmst, wird dir auf lange Sicht Erfolg und Glück ins Haus bringen.","4-32":"Ein bestimmtes Haus oder eine bestimmte Wohnung steht im Mittelpunkt deiner Aufmerksamkeit. Ein schönes Haus, sehr repräsentativ. Wenn du dir Mühe gibst, hast du eine reelle Chance.","4-33":"Deine Pläne gelingen und du hast den Haustürschlüssel quasi schon in der Hand. Es bieten sich günstige Gelegenheiten und gutes Gelingen für einen eventuellen Neuanfang.","4-34":"Hier kann es sich um ein Haus oder eine Wohnung nah am Wasser handeln. In jedem Falle aber ist die Familie in der kommenden Zeit wirtschaftlich gut aufgestellt. Sieh dich in deinem Haus genau um. Wie innen, so außen. Wenn dir etwas nicht so gut gefällt, bessere es jetzt aus, denn sonst verstärkt es den ungünstigen Einfluss.","4-35":"Vielleicht bist du dabei, dir ein Homeoffice einzurichten, Renovierungsarbeiten vorzubereiten oder auf der Suche nach deiner ureigenen Berufung.","4-36":"Sei sehr aufmerksam! Was dir als nächstes ins Haus kommt wird einen entscheidenden Einfluss auf dein weiteres Schicksal haben.","5-6":"Was an dieser Situation unklar ist, wird es noch lange bleiben. Du brauchst Geduld, um deine Gedanken und Ideen einbringen zu können. Kannst du sie nicht aufbringen, droht ein Projekt oder Vorhaben zu scheitern.","5-7":"Die Dosis macht das Gift. Kontrolliere, in welchem Lebensbereich du derzeit vielleicht zu viel oder zu wenig von etwas bekommst.","5-8":"Es scheint sich absolut nichts zu tun, rein gar nichts. Wenn du aber mal einen Eichenbaum beobachtest, dann scheint sich auch nichts zu tun, und es entwickelt sich dennoch. Es wird sehr langsam voran gehen. Auch wenn es dir vielleicht schon langweilig wird und sich die Situation so oft wiederholt hat, dass du keine Lust mehr daran hast, bleib dennoch dran. Eine schlimme Befürchtung in Bezug auf jemandem oder etwas, dass dir und deinem leiblichen Wohl nahe steht, hat die Tendenz sich zu verwirklichen. Hier musst du gegensteuern!","5-9":"Dafür das es so lange gedauert hat, um sich zu entwickeln, geht es ab jetzt relativ zügig und vor allem auf sehr erfreuliche Art und Weise voran. Eine Überraschung hat handfeste Folgen. Aber du brauchst noch etwas Geduld, bevor es sich offenbart.","5-10":"Die Zeit zum Handeln ist reif. In dieser Situation auszuharren kann unübersehbare Gefahren bergen. Es ist besser zu handeln. Warte nicht zu lange. Auch wenn es schwer fällt, sich von alten Dingen zu lösen, vielleicht aus Gewohnheit oder aus Angst vor dem Loslassen, solltest du jetzt die Initiative ergreifen.","5-11":"Wenn dieser Situation eine Meinungsverschiedenheit oder sogar ein Streit voraus ging, wird es auch noch eine Weile dauern, ehe sich wieder Gespräche anbahnen. Wunden müssen erst heilen. Funkstille, aber noch nicht endgültig.","5-12":"Glaube nicht alles, was gesagt wird. Diese Schwierigkeiten dauern länger als erwartet. Was du hörst kann dir an die Nieren gehen, vor allem, wenn du nicht genau weißt, aus woher es kommt. Wie die Vöglein sich im Baum verstecken können, siehst du nicht, wer über dich redet, aber du bekommst es zu hören.","5-13":"Diese Situation ist der Anfang von etwas Großem. Jemand oder etwas wird dich von Anfang an und für eine lange Zeit begleiten. Auf die Erfüllung dieses Wunsches hast du schon lange gewartet. Jetzt wird er endlich wahr.","5-14":"Diese Situation solltest du wirklich genau betrachten. Du hast so etwas in ähnlicher Form schon ein ums andere Mal erlebt. Jetzt hast du die Chance, sie abzuschließen, es nicht wieder falsch zu machen. Nicht alles was falsch zu sein scheint ist deshalb auch unnütz. Auf einer tieferen Ebene deines Seins hat diese Situation einen Sinn und ist als Erfahrung gut für dich und deine Seele. Geh langsam voran.","5-15":"Alles was du hast oder bist, hast du dir über lange Zeit hart erarbeitet, setze es jetzt nicht durch Eigenwilligkeit aufs Spiel. Du findest Schutz und neue Kraft in der Natur. Du könntest einem imposanten Herrn aus dem Gesundheitswesen begegnen. Vielleicht einem Arzt, einem großen und kräftigen Pfleger, Masseur oder einem Fitnesstrainer.","5-16":"Wer sich Zeit lässt, hat auch Zeit zum Träumen. Träume konstruktiv und sie werden wahr. Glückliche Umstände bringen dich nach langer Zeit doch noch ans Ziel. Vielleicht hast du jetzt deinen Standpunkt zu dieser Situation verändert.","5-17":"Du hast vielleicht schon zu lange an der Umsetzung deines Ziels gearbeitet und bist kurz davor, aufzugeben. Durch diese gedankliche Veränderung deines Standpunktes und dem damit verbundenen Loslassens, verändern sich nun die Vorzeichen und es geht weiter.","5-18":"Wenn du derzeit ein Problem zu lösen hast, nimm eben mal deinen Freundeskreis unter die Lupe: Wer kann dir dabei helfen, vielleicht einen guten Rat geben, wer ist krank und braucht vielleicht deine Hilfe oder von wem solltest du dich eine Weile distanzieren, wer macht dich krank?","5-19":"Diese Situation ist sehr komplex und lässt sich nicht über Nacht lösen. Du wirst viel Disziplin brauchen.","5-20":"Mit etwas Fantasie, Kreativität und handwerklichem Geschick kann man aus einem toten Stück Holz ein Standbild schnitzen. Was kannst du als nächstes tun? In der Nähe eines Krankenhauses, auf einem Gesundheitsvorsorge- Seminar oder in einer Selbsthilfegruppe findest du wichtige Aspekte für die Antwort auf deine Frage.","5-21":"Mit großer Beharrlichkeit hast du dir selbst so Gedanken gemacht wie: Ich kann es nicht schaffen. Es ist zu schwer. Ich mag das oder denjenigen nicht. So stehst du noch immer vor deiner Herausforderung und wirst immer giftiger. Kehre diesen Prozess um, bevor du weiter gehst. Weil das Ziel so weit in der Ferne liegt, drohst du mutlos zu werden. Das brauchst du nicht; du hast mehr Kraftreserven als du denkst.","5-22":"Du bist selbst reif und erwachsen genug um gute und richtige Entscheidungen zu treffen, jedenfalls solltest du es sein. Wenn du dir bei einer Entscheidung noch nicht im klaren bist, welchen Weg du gehen sollst, suche dir etwas, das dir Sicherheit gibt und überlege noch einmal genau.","5-23":"Die Sorgen, die du dir machst, gehen langsam an deine Substanz. Wenn man dich von außen her beobachtet, könnte man denken, etwas an der Situation gefällt dir auch. Steter Tropfen höhlt den Stein. Wenn du selbst etwas erreichen willst, zeige Mut und Ausdauer. Auch wenn du den anderen mit unter auf die Nerven gehst, bleibe beharrlich. Schau dich in deinem sozialen Umfeld genau um, wer da von deiner Energie zehrt. Energievampiere rauben dir die Kraft.","5-24":"Nicht alles, was das Herz begehrt, macht auch glücklich. Du bist voller Energie und dein Herz schlägt leidenschaftlich für jemanden oder etwas, frischer Lebenssaft durchströmt deine Glieder.","5-25":"Zusagen, die du jetzt triffst, werden dich lange in der Pflicht halten. Darum prüfe, wer sich ewig bindet… Wenn man sich begegnet, soll man sich zuerst besser kennen lernen, bevor man heiratet. Aber wenn man sich lange genug kennt, kann es passieren, dass man nicht mehr heiraten möchte. Überlegtes Handeln bringt mehr Sicherheit.","5-26":"Dieses Geheimnis wird noch lange unentdeckt bleiben. Es gibt noch viel in dieser Situation zu lernen oder zu begreifen, ehe sie abgeschlossen haben wirst.","5-27":"Es kommen gute Nachrichten an, die aber letztlich wenig Bewegung in die Sache bringen werden. Es ist ein langer Weg, ehe aus einem großen, starken Baum ein Blatt Papier für einen Brief wird. Die Nachricht kommt scheinbar verspätet an, aber das hat schon seinen Grund.","5-28":"Als Person: Dieser Mann ist vielleicht im medizinischen Bereich tätig, ein Masseur oder ein Fitnesstrainer. In jedem Falle aber ein Kerl wie ein Baum. Als Situation: Manchmal kommen wir uns vor, wie in einem Laufrad: Je schneller wir uns um uns selbst drehen, desto weniger kommen wir voran.","5-29":"Als Person: Diese Dame ist ökologisch sehr engagiert, vielleicht sogar Vegetarier, in jedem Falle kann sie eine starke Neigung zur Natur und zur Naturreligion inne haben. Als Situation: Wenn wir um die Lösung eines Problems bitten, müssen wir auch bereit sein, die Antwort anzunehmen. Manchmal ist es sinnvoll eine Auszeit zu nehmen, damit sich die Nerven entspannen.","5-30":"Nutze besser ökologische, französische Froschblasenkondome, das verhindert beim Sex eine Latexallergie. Vorbeugen. Weniger ist manchmal mehr und purer Luxus kommt aus der Freude am Betrachten. Das ist wundervoll, aber ist es auch zwingend notwendig, um glücklich zu sein? Versuche dich von deinen Wünschen unabhängig zu machen, bevor sich dein Herz nach ihnen verzehrt; erst dann haben sie eine reelle Chance, wahr zu werden.","5-31":"Weil du gelernt hast, deine Kräfte gut einzuteilen, kommt eine wahre Erfolgswelle auf dich zu. Setze für dein Wohlbefinden mehr auf grüne Nahrung.","5-32":"Teile deine Kräfte gut ein, es könnte für längere Zeit beschwerlich und/ oder langweilig werden. Bleib dran. Manchmal ist der Weg zum Erfolg, zu Ruhm und Anerkennung, mit vielen kleinen, langweiligen Routinearbeiten gepflastert. Halte durch, es lohnt sich.","5-33":"Die Zeit ist reif und nun lohnt sich endlich all die Mühe. Jetzt wird vieles, was sehr schwierig war, erstaunlich leicht gehen. Du hast eine schwierige Aufgabe zu lösen, schau das du die richtigen Werkzeuge, die richtige Ausrüstung hast.","5-34":"Was du dir jetzt durch lange Phasen harter Arbeit und Geduld selbst geschaffen hast, vermehrt sich nun fast wie von alleine.","5-35":"Das Ziel, das du dir gesetzt hast, erscheint dir vielleicht noch in sehr weiter Ferne, aber durch deine Strebsamkeit bleibst du dran und gibst dir viel Mühe. Dieses Thema solltest du loslassen. Überlege einmal selbst, wie lange du schon darauf herum kaust…","5-36":"Langeweile erscheint uns oft als schwere Bürde. Lenke dich ab, aber behalte stets dein Ziel im Auge. Diese Situation ist eine wichtige Prüfung. Jetzt bist du reif genug, um sie zu bestehen.","6-7":"Es gibt Schwierigkeiten und Verwicklungen, die auf diffuse Informationen basieren, allerdings sind sie nicht von langer Dauer. Dieses ältere Paar, vielleicht die Schwiegereltern, Verwandte oder Bekannte, ist eher etwas eigen… freundlich ausgedrückt. Durch einen Verrat erleidest du einige Rückschläge. Eine Rivalin macht Schwierigkeiten. Die Versuchung ist groß, du musst ihr widerstehen, damit du dein Ziel erreichst. Solltest du es nicht schaffen, erwarten dich Schwierigkeiten und du musst einige","6-8":"Ein Gewitter zieht auf, vielleicht spürst du es schon (meist an einem komischen Gefühl in der Magengegend). Bereite dich gut vor. Weil du nicht alle wichtigen Einzelheiten kennst, und die Sache noch ziemlich undurchsichtig ist, wird es dir einen schönen Schrecken einjagen, wenn es soweit ist.","6-9":"Dafür das es so lange gedauert hat, um sich zu entwickeln, geht es ab jetzt relativ zügig und vor allem auf sehr erfreuliche Art und Weise voran. Eine Überraschung hat handfeste Folgen. Aber du brauchst noch etwas Geduld, bevor es sich offenbart.","6-10":"Hektische Zeiten erwarten dich. Was immer auch dein Thema sein mag, es herrscht in dieser Beziehung dicke Luft. Plötzliche Gefahr und du weißt noch gar nicht so genau, woher sie kommt. Deine Stimmung ist eher aggressiv und unausgeglichen, vielleicht ein alter Schmerz, der dich nicht los lässt. Wenn du diese Stimmung bemerkst, forsche nach der Ursache.","6-11":"Du wirst dich mit einer männlichen Person streiten, dieser Mann ist verärgert und meint, die besseren Argumente zu haben. Suche nach einer besseren Lösung.","6-12":"Du bekommst einen Anruf, eine SMS, wirst zu einem Gespräch gerufen, das dich verärgert. Lass dich nicht zu sehr runter ziehen, das lohnt sich in diesem Falle nicht. Klatsch und Tratsch am Telefon, dass kann mal ganz lustig sein, bringt dich persönlich aber nicht weiter. Schau, dass du darüber hinaus kommst.","6-13":"Dieser Neuanfang gelingt nur zögerlich, es ist ein Start mit Hindernissen. Neue Projekte sind als Idee schon ganz in deiner Nähe, halte die Augen geöffnet. Vielleicht ist die Idee aber auch schon da, es muss nur noch mehr recherchiert werden, da es sonst zu unvorhergesehenen Schwierigkeiten kommen kann.","6-14":"Du triffst in deinem persönlichen Umfeld einen gefährlichen Intriganten. Sei auf der Hut, sonst folgen Rückschläge und Schwierigkeiten.","6-15":"Was immer du auch erreichen möchtest, du stehst einem mächtigen Widersacher gegenüber. Hindernisse und Rückschläge folgen, suche Schutz und Kraft in deinem Selbst. Du bist stärker, als du vielleicht denkst.","6-16":"Das Problem mit Ersatzbefriedigungen (Rauchen, Alkohol, zu viel Essen…) zu kompensieren ist auf die Dauer nicht zielführend. Momentan ist es noch unklar, wie sich dein Traum erfüllen soll. Mächtige Eingebungen durchdringen den Nebel täglicher Gedanken.","6-17":"Jetzt ist es an der Zeit, aus Schaden klug zu werden und dadurch die gewünschten Veränderungen herbei zu führen. Wenn du eine neue Wohnung suchst oder ein Haus zum Kauf, wirst du in der nahen Zukunft noch nicht fündig. Werde dir einmal klar darüber, was du genau suchst, dann kann das Universum dir bessere Hilfe leisten.","6-18":"In deinem persönlichen Umfeld musst du mit ansehen, das es Ärger und Schwierigkeiten um oder mit einem Freund gibt. Hilf die Unklarheiten zu beseitigen.","6-19":"Ärger mit Behörden oder Ämtern stehen bevor. Diese Einsamkeit macht dich traurig und dennoch weißt du nicht genau, wie du es ändern kannst.","6-20":"Du gerätst in eine peinliche Situation. Es kann auch sein, dass du das Gefühl von Fremdschämen erlebst. Sieh dich in der nächsten Zeit etwas vor.","6-21":"Was du auch ausprobierst, es wird dir nicht gelingen. Spare deine Energie und starte zu einem späteren Zeitpunkt neu. Keep calm and relax.","6-22":"Durch fehlende Informationen oder wegen einigen Unklarheiten kann es geschehen, dass du dabei bist, eine folgenschwere Entscheidung zu treffen.","6-23":"Die Situation beginnt sich aufzuklären, Schatten verziehen sich und es geht wieder aufwärts. Nun hast du Rückschläge gut überstanden und deine Sachen geordnet, so dass es wieder besser werden kann. Wenn nicht, solltest du das schleunigst tun.","6-24":"Du bist mit der Gesamtsituation unzufrieden und schaffst es dadurch, dir selbst und anderen die Laune zu verhageln.","6-25":"Wenn du ein neues Projekt oder eine Partnerschaft eingehen willst, überlege noch einmal genau. Es kann sein, dass du noch gar nicht alle Umstände kennst und eventuelle Unklarheiten spätere Enttäuschung mit sich bringt.","6-26":"In deiner Nähe wartet ein Geheimnis darauf, aufgedeckt zu werden. Diese Heimlichkeiten verursachen Unruhe. Es ist noch nicht ganz klar, in welcher Richtung deine Karriere weiter gehen soll. Es wäre sinnvoll, erst einmal die eigenen Gedanken zu klären, damit es weiter gehen kann.","6-27":"Wenn du auf eine Nachricht in einer bestimmten Angelegenheit wartest, kann es jetzt zu einer Absage kommen. Das scheint zunächst eine derbe Enttäuschung zu sein, stellt sich im Nachhinein aber als Vorteil heraus.","6-28":"Als Person: Dieser Herr fühlt sich unwohl. Unklarheiten über etwas oder jemanden schlagen sich auf sein Gemüt. Als Situation: Deine Vorstellungen werden ablehnend betrachtet. Es tun sich Schwierigkeiten auf, die zu beheben anstrengend und darüber hinaus überflüssig sind.","6-29":"Als Person: Diese Dame macht sich einiges Kopfzerbrechen, weil sie Rückschläge befürchtet. Sei geduldig. Als Situation: Immer die Vorstellungen anderer zu erfüllen bereitet dir mehr und mehr Unbehagen.","6-30":"Du machst dir vielleicht zu viele Sorgen um deine Familie und um nahe Angehörige. Das macht dich müde und raubt dir Energie. Denke immer daran: Sorgen macht man sich nur um die Menschen, denen man nicht zutraut, mit dem Leben zurechtzukommen.","6-31":"Hinter den Wolken scheint immer die Sonne! Denke immer daran und bleib optimistisch. Unerwartete Glücksfälle helfen über eventuelle Rückschläge und Hindernisse hinweg.","6-32":"Was du auch versuchst, der ausbleibende Erfolg will dich entmutigen. Dabei kommt er nur daher, dass du noch nicht alle Unklarheiten beseitigt hast. Wenn du dich genau auskennst, wirst du bald erfolgreich.","6-33":"Diese Hindernisse kommen mit Sicherheit noch auf dich zu. Wenn du gut gerüstet bist, kannst du sie schnell überwinden. Baldiger Durchbruch.","6-34":"Achte in allen Bereichen deines Lebens auf Ausgeglichenheit, damit du nicht mehr (aus-) gibst, als du besitzt. Die Unklarheiten, Hindernisse und Schwierigkeiten nehmen noch zu.","6-35":"Viele deiner dunklen Gedanken sind aus lauter Gewohnheit in einem mürrischen, unzufriedenen und meckerndem Ton. Daraus resultieren die vielen Schwierigkeiten. Hör mal genau hin…","6-36":"Du wirst einen scheinbaren Rückschlag erleiden, der aber nicht nur notwendig ist, sondern letztlich auch ans Ziel führen wird. Diese Hindernisse zu überwinden ist Teil einer schicksalhaften Prüfung.","7-8":"Jemand oder etwas wird dir einen heftigen Schrecken einjagen. Eine ältere Dame, die dir sehr nahe steht, bekommt einen mächtigen Schrecken. Durch einen Verrat an etwas oder jemanden gerätst du in eine schwierige und belastende Situation.","7-9":"Zwei Frauen, eventuell Mutter und Tochter oder zwei Freundinnen, werden in dieser Situation wichtig. Vielleicht wird aus Freundschaft Feindschaft oder aus Freundinnen werden Rivalinnen, in jedem Falle kann es zu extremen Verwicklungen und Verstrickungen kommen.","7-10":"Eine Frau kann sich erholen. Spannungen unter Rivalinnen entspannen sich. Die Arbeit ist getan und die Ernte eingefahren. Jetzt wird es wieder ruhiger. Angriff von einer Frau oder Rivalin. Achtung: Sie kämpft mit unsauberen Mitteln, mit Falschheit und Verrat. Zwei Frauen kämpfen um einen Mann, wie zwei Löwinnen um - einen Esel!","7-11":"Du begegnest einer redegewandten und ausdrucksstarken Frau. Besser, sie wird deine Freundin. In hitzigen Wortgefechten werden schon einmal Dinge gesagt, die man besser nicht gesagt hätte oder die man so nicht gemeint hat. Achte auf deine Worte.","7-12":"Deine Freundin wird dich anrufen, denn sie hat Sorgen. Sie wirkt nervös und hektisch; lass dich nicht anstecken.","7-13":"Sprich noch einmal mit deiner Freundin über diese Angelegenheit, letztlich wird sie dir hilfreich zur Seite stehen. Eine Freundin ist leider nicht so unschuldig, wie es zu sein scheint. Aus einer anfänglichen Rivalität könnte sich eine neue Beziehung entwickeln, auf welcher Ebene auch immer.","7-14":"Eine Rivalin, Lügnerin oder Intrigantin versucht deine Pläne zu durchkreuzen, vielleicht indem sie deine Freundschaft sucht und dann ausnutzt. Sei auf der Hut.","7-15":"Dieses Paar hat es in sich. Wenn es sich um Personen handelt, suche ihre Nähe, um an dieser Energie teil zu haben. Ein großes Ziel wird nur auf Umwegen erreicht. Du triffst eine Frau, die sich durchsetzen kann, vielleicht die Chefin oder eine leitende Angestellte. Du kannst sie um Rat oder Hilfe bitten.","7-16":"Dein tiefster Herzenswunsch wird in Erfüllung gehen, auch wenn es auf Umwegen geschieht. Deine Intuition ist gut geschult, gib acht, dass sie dich nicht in Versuchung führt, sie für deine eigenen Zwecke auszunutzen. Die Verwicklungen in dieser Situation lösen sich auf und du siehst wieder klar.","7-17":"Wenn du umziehen willst, so findest du deine neue Wohnung oder dein neues Haus nur auf Umwegen. Vielleicht erkennst du nach vielem hin- und herüberlegen, dass es Zeit wird, alle unsinnigen Gedanken loszulassen und eventuell einen neuen Standpunkt einzunehmen.","7-18":"Eine ältere Dame, die Schwiegermutter vielleicht, verletzt deine Grenzen, nur weil du zu treu und gutmütig bist und nicht gelernt hast NEIN zu sagen.","7-19":"Um dein Ziel zu erreichen musst du jetzt klare Absprachen treffen. In behördlichen Angelegenheiten wird es zu einigen Verwicklungen kommen.","7-20":"Eine Frau, die in der Öffentlichkeit steht oder deren Meinung viele Menschen wertschätzen, wird auf dich aufmerksam. Diese Situation kommt einem Verrat gleich und das Schlimme ist, dass so viele Menschen davon etwas mitbekommen. Wie peinlich.","7-21":"Wenn du ein Problem nicht lösen kannst, musst du einige Umwege in Kauf nehmen. Das dauert zwar etwas länger, gelingt dann aber auch besser. Einen steilen Berg erklimmt man am besten indem man ihn umkreist. Serpentinen, zum Beispiel in der Eifel, sind ein gutes Beispiel dafür. Vielleicht schleichst du aber auch schon länger wie die Katze um den heißen Brei. Schiebe deine Probleme nicht mehr vor dir her, schreite jetzt mutig voran, das Universum ist mir dir.","7-22":"Du wirst nicht umhin kommen, eine Entscheidung zu treffen, auch wenn es dich windet. Überprüfe noch einmal deine Entscheidung. Kann sein, dass sie dich zwingt, Umwege in Kauf zu nehmen.","7-23":"Eine Situation entwirrt sich. Eine Frau hilft dir dabei, den Faden wieder anzuknüpfen. Eine Frau, Freundin oder Rivalin, jedenfalls eine Frau, die auf eine besondere Art in deinem Leben eine Rolle spielt, wird einen Verlust erleiden, was (meist positive) Auswirkungen auf dein Leben hat: “Wat den ein sien Uhl, is den annern sien Nachtigall.” (Was für den einen eine Eule bedeutet- also etwas nicht so schönes, kann für den anderen eine wundervolle Nachtigall darstellen.)","7-24":"Mit dem Herzen begehrst du das, was dein Verstand als “unvernünftig” ablehnt. So kommt es, dass du dich in dieser Situation im Kreis drehst und vielleicht sogar darunter leidest. Jemand oder etwas, das dir sehr wichtig ist, droht an eine Rivalin zu fallen. Eine neue (alte) Liebe könnte nun wieder aufblühen.","7-25":"Um welche Art Bindung es sich auch handelt, die du vielleicht gerne, vielleicht “zu” gerne, eingehen möchtest, dieser Vertrag kommt nur zögerlich und auf Umwegen zu Stande. Diese Frau ist noch gebunden, auch wenn sie vielleicht etwas anderes sagt, ist sie in ihrem Herzen doch noch nicht frei.","7-26":"Eine sehr kluge, vielleicht studierte Frau wird dir begegnen und in dieser Situation weiter helfen. Dein Studienziel wirst du nicht in direkter Linie erreichen. Achte auf dein Tagebuch, wenn du eines führst, es könnte unter die falschen Augen geraten.","7-27":"Du erwartest ein Lebenszeichen, eine Nachricht in einer bestimmten Angelegenheit oder von einer bestimmten Person, eine SMS oder E-Mail? Die Information kommt von unverhoffter Seite und vielleicht, wenn überhaupt, nur auf Umwegen ans Ziel. Halte die Augen und Ohren offen.","7-28":"Als Person: Dieser Herr ist noch nicht bereit für eine neue Beziehung. Vielleicht hat er eine Geliebte oder er ist noch verheiratet, in jedem Falle aber kommt eine Beziehung nicht ohne Schwierigkeiten zu Stande. Als Situation: Wenn dir diese Angelegenheit wirklich wichtig ist, dann wirst du dein Ziel auch erreichen.","7-29":"Als Person: Diese Dame könnte dir in der einen oder anderen Weise gefährlich werden. Es kann sein, dass sie zur Rivalin wird oder dass sie dich verführt, in jedem Fall ist sie ein Abenteuer aus dem sich etwas sehr Ernstes entwickeln kann. Als Situation: Verfolge dein Ziel immer so, als würdest du es nicht verfolgen. Je mehr wir von einem Wunsch besessen sind, umso weniger wird er sich erfüllen. Je mehr wir etwas wollen, umso mehr entzieht es sich uns.","7-30":"Auf einer höheren Ebene ist die Harmonie bereits wieder her gestellt. Es dauert nur noch eine Weile, bis es sich auf der materiellen Ebene manifestiert. Dein heimlicher Verehrer hat höchst wahrscheinlich noch eine Geliebte… Wenn es sich nicht um reine Lust und Lebensfreude handelt, solltest du diese Verbindung auflösen.","7-31":"Das Glück erreicht dich auf Umwegen, es kommt zu dir aus einer Richtung, die du nicht erwartest. Suche das Glück in deinem Leben, es ist schon da, nur vielleicht hältst du nach dem falschen Glück, nur nach dem Katzengold Ausschau.","7-32":"Der Ausgang dieser Situation wird erfolgreich sein, auch wenn im Augenblick noch nicht zu erkennen ist, wie.","7-33":"Der Erfolg ist dir in dieser Situation sicher. Auch wenn für lange Zeit Verwirrung herrschte, kehrst du jetzt in deine Sicherheit zurück. Eine Rivalin kann jetzt ausgeschaltet, ein Hindernis überwunden werden.","7-34":"Die Verwirrung wird größer und die Unsicherheiten nehmen zu. Eine Frau, Freundin, Mutter, oder sogar eine Rivalin bekommt mehr Energie, mehr Kraft für ihre Absichten, ihr Einfluss nimmt erheblich zu.","7-35":"Aus der Verwirrung heraus bewegst du dich langsam aber sicher (wie ein Anker an seiner Kette) wieder in Richtung Stabilität und Sicherheit.","7-36":"Achtung, das Schicksal schlägt heftig und unvermittelt zu. (Wie eine Kobra hervor schnellt und Gift spritzt.) Auch wenn es ein schmerzhafter Prozess zu sein scheint, vorbereitet und in abgeschwächter Form kann dieses Gift zur Heilung beitragen.","8-9":"Unangenehme Ereignisse kommen auf dich zu, vielleicht bekommst du einen Schrecken eingejagt wegen jemandem oder etwas, vielleicht bekommst du auch eine Absage für eine Party oder etwas dieser Art.","8-10":"Diese Unannehmlichkeiten sind vielleicht heftig, gehen aber genau so plötzlich, wie sie gekommen sind. Eine belastende Situation wird nun ziemlich abrupt abgeschlossen.","8-11":"Dieser Streit ist arg aus dem Ruder gelaufen. Er kann sogar so heftig sein, dass es zum Bruch zwischen den Streitenden kommen kann.","8-12":"Es folgen viele Gespräche, die nicht zum Ziel führen, vielleicht sogar unsinnig sind und das weißt du auch. Du bekommst schlechte Nachrichten, die aber nicht so schlimm sind, wie es zuerst zu sein scheint.","8-13":"Die Erfüllung deines Wunsches wird noch eine Weile auf sich warten lassen. Schau, was du statt dessen tun kannst. Eifersucht führt zu nichts.","8-14":"Hier wird das Ende einer Intrige angezeigt, Lug und Betrug werden aufgedeckt und Wahrheit und Gerechtigkeit kommen wieder ans Tageslicht.","8-15":"Behördenangelegenheiten gehen nicht so gut aus, wie du es vielleicht erwartet hast. Ein Beamter, ein Richter oder Anwalt ist dir gegenüber negativ eingestellt. Das verschlechtert die Situation.","8-16":"Die Krise ist vorüber, du kannst deine Sachen neu sortieren und von vorne anfangen. Bei Lichte betrachtet ist es nicht ganz so schlimm geworden, wie du es vielleicht erwartet hast und die Voraussetzungen für einen Neuanfang sind nicht so schlecht.","8-17":"Die erhoffte Veränderung wird nicht stattfinden, jedenfalls jetzt noch nicht. Und wenn jemand oder etwas sich doch unerwartet verändern sollte, dann auf keinen Fall so wie erwartet. Der Schuss geht nach hinten los.","8-18":"Im Moment brauchst du nicht auf die Hilfe deiner Freunde hoffen. Für deine Unternehmung wirst du keine Unterstützung bekommen.","8-19":"Wenn du im Moment Schwierigkeiten mit einem Amt oder einer Behörde hast, wirst du wenig Glück haben und selbst die geschicktesten Vorhaben werden dir misslingen. Achte darauf, dass du dich nicht zu arg von der Welt isolierst. Dir selbst kannst du doch nicht entrinnen. Auch wenn deine Seele vielleicht die Einsamkeit kennenlernen möchte, so kannst du doch bestimmen, dass du diese Erfahrung nun gemacht hast und gerne etwas anderes erleben möchtest.","8-20":"Eine schon lange geplante Veranstaltung, Party oder Gesellschaft fällt leider aus. Etwas in einem Park oder auf öffentlichem Gelände erregt dermaßen deine Aufmerksamkeit, dass du wie zur Salzsäule erstarrst. Vielleicht dass du jemanden unverhofft wieder triffst und das erschrickt dich so sehr, fast als hättest du einen Geist gesehen.","8-21":"Mit jemandem oder etwas verschwendest du nur deine Zeit. Es wird sich doch nichts ändern, auch wenn du dich sehr anstrengst und dir viel Mühe machst. Vergiss es einfach und frage dich, was du statt dessen tun kannst.","8-22":"Es fühlt sich an, als solltest du dich zwischen Regenwetter und Schneesturm entscheiden. Nichts deutet darauf hin, dass du eine echte Wahl hast und eine gute Entscheidung treffen könntest.","8-23":"Unsichtbare Helfer sind am Werk und bereiten deinen größten Sorgen schon heimlich ein Ende. Du wirst von deinem Elend befreit werden. Dieser Schrecken hat schon bald ein Ende.","8-24":"Es folgt eine Zeit des Liebeskummers. Vielleicht geht es um eine unerfüllte Liebe oder darum, dass einer von Zweien mehr zu lieben scheint als der andere. Vielleicht hast du dein Herz aber auch vor der Welt verschlossen, nur damit es nicht noch mehr verletzt werden kann. Doch dabei hast du vielleicht nicht beachtet, wo genau du es hingelegt hast…","8-25":"Diese Verbindung wird beendet. Es ist das Ende einer Ehe, einer Beziehung, einer Partnerschaft oder eines Arbeitsvertrages. Versuche nicht, etwas daran zu ändern, die innere Kündigung hat schon vor langer Zeit stattgefunden, und das weißt du auch, wenn du ehrlich zu dir selbst bist.","8-26":"Ein Geheimnis wird mit etwas oder jemandem sprichwörtlich zu Grabe getragen und es gibt keine Möglichkeit mehr, es zu lösen. Ein Studium wird nicht begonnen (oder nicht abgeschlossen), weil eine Prüfung nicht bestanden wurde oder die Zensuren nicht ausreichten.","8-27":"Du erhältst eine negative Nachricht, eine Absage vielleicht die dich schockiert oder den Schrecken in die Glieder fahren lässt. Vielleicht handelt es sich auch um eine Kündigung. In jedem falle kommt es in etwa so, wie du es befürchtet hast.","8-28":"Als Person: Dieser Herr hat gerade einen Schock erlitten, schlechte Nachrichten bekommen oder ein Trauma verarbeiten müssen. Sei sehr behutsam. Als Situation: Auch wenn du jetzt dringend etwas unternehmen willst, um auf die Situation einzuwirken, wird es doch nichts nützen.","8-29":"Als Person: Diese Dame hat gerade einen Schock erlitten, schlechte Nachrichten bekommen oder ein Trauma verarbeiten müssen. Sei sehr behutsam. Schneewittchensyndrom. Als Situation: Du gehst anders mit der Situation um, versuchst dennoch das Gute darin zu erkennen oder eben deinen Schrecken zu verarbeiten. Manchmal machst du dir eben einfach zu viele Sorgen.","8-30":"Dein Sexualleben ist schon lange Zeit eingeschlafen. Erwecke es zu neuem Leben, damit auch du wieder auf blühst. Es gibt vielleicht mehr Möglichkeiten, als du im Moment glauben magst.","8-31":"Das Glück kommt wieder, nach einer langen Strecke der Entbehrungen und Anstrengung. Genieße diese warmen Tage, du hast sie wirklich, wirklich redlich verdient.","8-32":"Du hast dich in eine Situation oder einen Wunsch derart hinein gesteigert, dass ohne diese Erfüllung alles tief Schwarz zu sein scheint und verloren in der Dunkelheit. Versuche diese Sichtweise zu relativieren.","8-33":"Etwas sehr Unangenehmes wird auf jeden Fall passieren, da die Ursache schon vor langer Zeit gesetzt wurde. Augen zu und durch! Nach langer Entbehrung bist du nun wieder auf Erfolgskurs.","8-34":"Wenn du dir immer nur Sorgen um jemanden oder etwas machst, wirst du immer mehr Grund dazu bekommen, dir neue Sorgen zu machen. Ein Teufelskreis.","8-35":"Mit dieser Energie wirst du dein Ziel nicht erreichen können. Etwas oder jemand lastet schwer auf dir und nutzt dich vielleicht sogar aus. In jedem Falle wirst du nicht mit dem nötigen Respekt behandelt und die Beziehungen zu anderen gelingt nur an der Oberfläche.","8-36":"Eine Periode des Lernens geht nun zu Ende. Wenn du diese Situation überstanden hast, geht es auf lichteren Pfaden weiter.","9-10":"Diese Überraschung kommt sehr plötzlich und völlig unerwartet. Vielleicht ist es ein kleines Geschenk oder eine nette Einladung. Du wirst hoch erfreut sein.","9-11":"Die folgenden Gespräche laufen besser als erwartet. Du wirst sehr überzeugend sein und deine Argumente kommen erstaunlich gut an. Es gelingt dir leichter, als du denkst, du musst nur ein wenig freundlicher sein, auch wenn es dir in dieser speziellen Situation schwer fallen sollte. Springe über deinen Schatten.","9-12":"Vielleicht weißt du schon von der Feier, bist aber noch nicht eingeladen. Die Einladung kann auch telefonisch erfolgen. Die Schwierigkeiten in dieser Situation werden bald beigelegt. Du bekommst ein kleines Geschenk, liebe Worte oder sogar einen Blumenstrauß, zur Versöhnung oder als Entschuldigung. Du solltest es auch annehmen.","9-13":"Mit dieser Einladung hast du nicht gerechnet. Nimm sie an, es wird ein fröhliches Fest in kleinem Rahmen. Wenn du etwas Neues in Angriff nehmen willst, ist jetzt eine gute Zeit, es in die Tat umzusetzen. Vielleicht wirst du sogar von noch ungeahnter Seite dazu eingeladen.","9-14":"Diese Freundlichkeit ist nicht so ehrlich gemeint, wie es den Anschein hat. Vielleicht ist es ein Angebot oder ein Geschenk, das aus Berechnung überreicht wird.","9-15":"Du hast dich in dieser Beziehung sehr angestrengt und den Erfolg redlich verdient. Genieße die Ehrungen und dann mach so weiter. Deine Durchsetzungskraft und Stärke beruhen auf deiner unerschütterlichen Freundlichkeit. Was immer du auch vorhast, die Person, der du Respekt zollst, wird dir überaus freundlich begegnen, dich fördern und dir Anerkennung zollen.","9-16":"Dein Wunsch wird in Erfüllung gehen, worum auch immer es sich handelt. Es folgen gesellschaftliche Anerkennung und eine schöne Zeit. Es war gut, dass du deiner Intuition gefolgt bist, jetzt zahlt es sich aus.","9-17":"Es hat sich einiges verändert, oder es verändert sich gerade noch. Du wirst mit dem Ergebnis überaus zufrieden sein. Wenn du eine neue Wohnung oder ein neues Haus suchst, wirst du jetzt das Schönste finden.","9-18":"Ein Freund steht dir zur Seite und du spürst, dass diese Unterstützung von ganzem Herzen kommt. Das tut gerade in dieser Situation besonders gut.","9-19":"Wenn du planst, dich künstlerisch zu betätigen, deine Kreativität auszuleben oder ein lange geplantes Projekt zu beginnen, wirst du jetzt besondere Freude daran empfinden und Glück haben.","9-20":"Hier geht es um besonders schöne Dinge und den Aspekt, es dir gut gehen zu lassen. Vielleicht planst du einen Besuch beim Friseur, Kosmetiker, Masseur oder in einem Einrichtungsgeschäft mit schönen Wohnaccessoires. Wenn nicht, dann solltest du es tun. Es ist ein Seelenschmeichler. Und vielleicht triffst du dort jemanden, den du schon lange vermisst hast.","9-21":"An dieser Stelle wirst du mit Freundlichkeit nicht weiter kommen, wenn das bisher deine Taktik war. Warst du bislang eher starrköpfig, dann ist Freundlichkeit die Alternative, die dich an dein Ziel führen wird.","9-22":"Du musst eine Entscheidung treffen und tust dich vielleicht schwer damit. Quäle dich nicht zu arg, denn die Karten sagen dir, dass du an dieser Stelle keine “falsche” Entscheidung treffen kannst. Wie du dich auch entscheidest, es wird gut ausgehen.","9-23":"Die Situation geht nicht so gut aus, wie erwartet. Gib nicht den anderen die Schuld, sondern schau zurück, wo dir deine Energie verloren ging. Das bringt dir Kraft für einen neuen Versuch.","9-24":"Du gehst in eine atemberaubend schöne Situation. Man könnte darüber sagen: Es ist fast zu schön, um wahr zu sein.","9-25":"Diese Verbindung ist vom Glück beschienen. Ob es sich um einen Vertrag handelt oder sogar um eine Hochzeit, es wird dir Glück bringen.","9-26":"Wenn du dabei bist, etwas neues zu lernen, ein neues Studium vielleicht, eine Weiterbildung oder ein Sprachkurs, so wirst du jetzt viel Freude daran haben. Es wird aufregend: Eine wundervolle Begegnung mit jemandem oder etwas, das du noch nicht kennst. Ein Abenteuer wartet auf dich.","9-27":"Vielleicht hast du diese Einladung schon erwartet oder erhofft oder vielleicht sogar schon damit gerechnet. Jetzt wirst du sie auch bekommen. In einer Sache bekommst du die Informationen, die du erhofft hast, die dich beruhigen und wieder fröhlich sein lassen.","9-28":"Als Person: Dieser Herr wird dir gerne Geschenke mitbringen oder vielleicht sogar einen Blumenstrauß. Er ist generell sehr romantisch veranlagt und liebenswert. Als Situation: Was du auch vorhast, tue es einfach, du wirst Glück dabei haben. Wichtig ist jetzt, dass du die Initiative ergreifst.","9-29":"Als Person: Diese Dame ist sehr fröhlich, romantisch und bescheiden. Ein echter Kumpel. Der Traum eines jeden Mannes. Als Situation: Es wird gut ausgehen, du musst nur abwarten, bis jemand oder etwas auf dich zu kommt. Keine vorschnellen Handlungen!","9-30":"Eine Familienfeier wird zu einem fröhlichen Fest, so dass du Kraft tanken kannst und dein Herz erfrischen. Jemand oder etwas schmeichelt dir. Genieße die Zeit und achte auf dein Herz.","9-31":"Du hast Erfolg auf ganzer Linie und dein Streben ist nicht nur für dich gut, sondern auch für die Menschen, die mit dir gehen.","9-32":"Komplimente sind Balsam für die Seele. Du wirst einige davon bekommen. Genieße die Zeit. Wenn du im künstlerischen Bereich tätig bist, wirst du nun erste Erfolge feiern können. Deine Arbeit und Bemühungen werden anerkannt.","9-33":"Das, was du dir wünschst, herbei sehnst oder erhoffst, wirst du jetzt überraschend schnell erhalten. Dein Vorhaben wird dir gelingen, nicht nur ganz gut sondern hervorragend. Wenn du jemanden zu überzeugen versuchst, solltest du Blumen sprechen lassen. Du wirst erstaunt sein, wie schnell du dadurch erfolgreich sein kannst. Denke immer daran: Kleine Geschenke erhalten die Freundschaft.","9-34":"Das kleine Glück vermehrt sich, alles funktioniert wie von selbst. Wenn du Hilfe brauchst, wirst du Unterstützung erhalten, wenn du Liebe suchst, wirst du geliebt werden und wenn du neue Ideen hast, werden sie wie von selbst zur Wirklichkeit.","9-35":"Behalte deinen Fokus auf die angenehmen Dinge in deinem Leben gerichtet, damit du lernst, sie zu erkennen, wenn sie da sind. Ein Anker kann wie eine Fußfessel sein, wenn wir es so wollen. Ein Anker kann aber auch Sicherheit geben, solang wir an einem Platz bleiben wollen. Wenn du der guten, alten Zeit nachtrauerst, wird das Glück ungesehen an dir vorüber ziehen.","9-36":"Diese Lebensaufgabe hast du erfolgreich abgeschlossen. Wenn es noch nicht danach aussieht, so wird es schon sehr bald so sein.","10-11":"Dir stehen Auseinandersetzungen bevor, und das ahnst du vielleicht auch schon. Bereite dich darauf vor, das gibt dir Sicherheit und vielleicht eine Möglichkeit zum Einlenken. Diskussionen können aus dem Ruder laufen. Lege besser nicht jedes Wort auf die Goldwaage.","10-12":"Vielleicht hörst du davon, dass man hinter deinem Rücken über dich geredet hat. Das tut weh, aber der Schmerz geht schnell vorüber. Diskussionen können aus dem Ruder laufen. Lege besser nicht alles, was dir zu Ohren kommt, auf die Goldwaage.","10-13":"Vielleicht hast du mit jemandem oder etwas noch einmal von vorne angefangen. Dieser Anfang wird plötzlich abgebrochen.","10-14":"Es scheint, als hätte sich die ganze Welt gegen dich verschworen. Jedoch nützt es nichts, wenn du jetzt mit Wut und Jähzorn reagierst. Atme tief und versuche einen anderen Weg zu finden.","10-15":"Du bist mit deiner Kraft am Ende und das raubt dir deine Energie, um deinen Status zu sichern und deinen Besitz zu beschützen.","10-16":"Glückliche Umstände und deine klare Intuition führen dazu, dass sich dein Wunsch oder dein Ziel, jemanden oder etwas zu erreichen, jetzt schnell erfüllen wird.","10-17":"Dieser Umzug kommt sehr plötzlich, du brichst alle alten Zelte ab und beginnst noch einmal ganz von Neuem. Manchmal muss man darauf achten, dass man nicht mit dem Po umreißt, was man mit den Händen aufgebaut hat.","10-18":"Mit der Treue und Unterstützung durch einen Freund brauchst du in dieser Situation nicht rechnen. Aus einem bestimmten Grund wirst du auf eine ablehnende Haltung oder sogar auf offene Aggression treffen.","10-19":"Dieses Gefühl der Einsamkeit bringt dich an die Grenzen des Erträglichen. Behördliche Angelegenheiten können jetzt abgeschlossen werden, es kann allerdings durchaus möglich sein, dass es zuvor noch etwas schlimmer wird.","10-20":"Wegen eines alten Schmerzes hast du dich ganz aus der Öffentlichkeit zurück gezogen oder vielleicht fühlst du dich auch nicht so wohl unter Menschen. Momentan ist der Kontakt im wahrsten Wortsinn abgeschnitten.","10-21":"Manchmal muss man nur lange genug warten, bis sich die Schwierigkeiten von selbst in Luft auflösen. Deine Geduld zahlt sich jetzt aus und der Weg wird wieder frei.","10-22":"Wenn du ehrlich in dein Herz schaust, weißt du, dass du keine andere Wahl hast. Es liegt nicht mehr in deiner Hand, dich zwischen mehreren Möglichkeiten zu entscheiden, letztlich läuft doch alles auf dasselbe hinaus.","10-23":"Dieser Kelch ist noch einmal an dir vorüber gegangen und du hast wirklich Glück gehabt, dass viele kleine Helfer, Schutzengel und Begleiter um dein Wohl bedacht sind, und auf dich acht geben.","10-24":"Liebeskummer und Eifersucht bohren sich in dein Herz, wie glühende Eisen. Versuche dich abzulenken und die Situation aus einer sachlicheren Perspektive zu betrachten.","10-25":"Ein Vertrag ist so weit, aufgelöst werden zu können. Prüfe, ob es sich dabei um eine Situation handelt, die du nun erfolgreich abgeschlossen hast oder ob eine Beziehung zu jemand oder etwas einfach auch abgelaufen ist. Von der Kündigung des Handyvertrages (der schon mal gern vergessen wird) bis hin zur Scheidung ist hier alles möglich.","10-26":"Ein Geheimnis wird offenbart; vielleicht aus Versehen oder weil es an der Zeit war, so oder so wird es viel Aufregung darum geben. Wenn dir eine Prüfung bevor steht, solltest du vielleicht noch einmal in die Bücher schauen, um sie zu bestehen.","10-27":"Wenn du auf ein Ja oder Nein wartest, mach dich eher darauf gefasst, dass es sich um eine Ablehnung handeln wird. Nimm es nicht persönlich, sondern wandere schnell weiter. Diese Nachricht kommt sehr schnell. Vielleicht zu schnell, um von der Ernsthaftigkeit der Antwort zu zeugen.","10-28":"Als Person: Dieser Herr könnte ein aufbrausendes Gemüt haben, vielleicht ist er auch etwas tollpatschig und leidet unter erhöhter Unfallgefahr. Als Situation: Es geht hoch her! Pass auf, dass du dir nicht weh tust.","10-29":"Als Person: Diese Dame könnte unter einem mehr oder weniger alten Schmerz leiden. Sie nimmt sich immer alles sehr zu Herzen. Als Situation: Es könnte ein Schlag aus einer unvermittelten Richtung kommen. Sei auf der Hut.","10-30":"Ein Liebhaber, Gönner oder Förderer wendet sich plötzlich von dir ab. Dies wird nicht die “große Liebe”. Aber es wird heiß und leidenschaftlich. Genieße die Zeit.","10-31":"In dieser Situation tappst du noch völlig im Dunkeln und es will dir einfach kein Licht aufgehen. Versuch es zu einem späteren Zeitpunkt noch einmal.","10-32":"In dieser Situation wirst du keinen Erfolg haben und das angestrebte Ziel wird nicht erreicht. Lass dich dadurch nicht in deiner Seele erschüttern, es geht immer irgendwie weiter.","10-33":"Vielleicht bist du ein Mensch, der sehr auf Sicherheit bedacht ist. Übertreibe es nicht mit deinem Sicherheitsbedürfnis, sonst könnte es zu unangenehmen Überraschungen kommen.","10-34":"Wenn du deine Aufmerksamkeit auf etwas richtest, dass du in deinem Leben nicht haben möchtest, verstärkst du damit seine Kraft und seinen Einfluss auf dich. Dabei ist es vollkommen gleichgültig, ob du dich nach Liebe oder nach Geld oder einer interessanten neuen Aufgabe sehnst, es wird dabei immer das Sehnen verstärkt.","10-35":"Wenn du jemanden oder etwas in deinem Leben hast, das du nicht loslassen kannst oder das an dir hängt ohne das du es möchtest, dann bekommst du jetzt die notwendige Unterstützung. Eine schwere Last wird von dir genommen.","10-36":"Wenn dich eine Situation sehr belastet, so wird sie sich jetzt sehr plötzlich und zu deinen Gunsten auflösen, die Prüfung ist bestanden.","11-12":"Wenn es nicht schon hektisch zugeht in deiner Welt, dann wird es bald soweit sein. Viele Gespräche finden statt und es wird eifrig diskutiert. Achte darauf, dass die Gefühle nicht überkochen.","11-13":"Du wirst hart dafür kämpfen müssen, um dir diesen Wunsch zu erfüllen. Wenn du dabei bist, ein neues Projekt oder eine neue Liebe zu beginnen, wird dieser Start mit viel Ärger und Aufregung verbunden sein. Achte darauf, dass es nicht vorbei ist, ehe es richtig begann.","11-14":"Lügen haben kurze Beine. Sie tragen auch nicht weit, und dann kommt es zu Diskussionen, in denen der eine die Tatsachen so gut zu seinen Gunsten drehen kann, wie der andere.","11-15":"Es kommt zu Auseinandersetzungen mit einer autoritären Person. Dabei kann es sich genau so um einen Chef oder Vorgesetzten handeln, wie einem Geliebten.","11-16":"Diese Worte sind nicht vergeblich gesprochen. Ein klärendes Gespräch, ein reinigendes Donnerwetter, erfrischt die Luft und klärt die Situation.","11-17":"Aus anregenden, mitunter auch heftigen Diskussionen entspringen neue, frische Ideen. Schreibe sie schnell auf, bevor sie wieder in Vergessenheit geraten.","11-18":"Vielleicht bist du enttäuscht, weil du auf die Hilfe und Unterstützung, wenigstens auf die moralische, eines Freundes gerechnet hast. Denke immer daran, dass uns an anderen nur stört, was wir an uns selbst nicht leiden können.","11-19":"Ärger zieht auf. Dabei kann es sich um Ärger in Behördenangelegenheiten handeln oder bei einem Projekt, an dem man selbstständig arbeitet. Wenn es sich um einen größeren Streit handelt, kann es jetzt zum Gerichtsprozess kommen.","11-20":"Es bahnen sich gesellige Stunden an. Vielleicht ein netter Abend unter Freunden, an dem viel diskutiert wird. Du wirst einen Auftritt vor Publikum halten, vielleicht ein Referat oder ein Vortrag in der Schule oder im Studium.","11-21":"Auch wenn du immer wieder das Gespräch suchst, wirst du an der Situation an sich auf diese Weise nichts verändern können. Denke immer daran: Du kannst den anderen nicht ändern, du kannst nur dich selbst verändern.","11-22":"Es gibt mehr als nur zwei Möglichkeiten und das macht deinem Verstand große Sorgen, da er Angst hat, nicht alle Aspekte und Konsequenzen zu kennen und somit eine falsche Entscheidung zu treffen. In deinem Kopf geht es immer nur: Ja, nein, ich mein JAIN! Gib diese Entscheidung an dein Herz ab und du kannst nicht fehlgehen.","11-23":"Dieser Ärger und der Streit gehen schneller vorüber, als du denkst. So genannte klärende Gespräche müssen daher auch nicht mehr geführt werden, das würde nur alte Wunden wieder aufreißen.","11-24":"In deinem Herzen herrschen Sturm und Chaos. Das kommt zum großen Teil aus deinem Verstand heraus, denn: Dein Herz kennt keinen Zweifel, dein Herz weiß immer ob Ja oder Nein! Und dein Verstand kann nicht glauben. Er denkt immer alles kontrollieren zu können oder zu müssen.","11-25":"Dieser Streit ist dir nicht neu. Es sind immer wieder die gleichen Gründe, die gleichen Unzufriedenheiten und die selben Gründe. Wenn du diesen Streit überwinden willst, solltest du nach den wahren Gründen für deine Unzufriedenheit suchen.","11-26":"Über dieses Thema könntest du schon ein Buch schreiben? Nur zu, es könnte ein Erfolg werden. Manchmal, wenn wir zu viel auf einmal im Kopf haben, ist es hilfreich ein Tagebuch zu führen.Dann sind deine Gedanken nicht verloren und du kannst es doch für den Augenblick loslassen.","11-27":"Wenn du neue Verträge oder Bindungen eingehen möchtest, ist jetzt eine gute Zeit dafür. Diese Dokumente oder Informationen sind sehr persönlich.","11-28":"Als Person: Dieser Herr ist eher streitsüchtig und meistens anderer Meinung. Als Situation: Hier musst du in die Offensive gehen. Manchmal ist Angriff das beste Mittel zur Verteidigung.","11-29":"Als Person: Diese Dame ist eher empfindlich und legt jedes Wort auf die Goldwaage. Als Situation: Es ist nicht immer von Vorteil, in jeder Diskussion und immer das letzte Wort zu behalten.","11-30":"Fröhliche Gespräche im Kreise der Familie. Nicht immer müssen es Grundsatzdiskussionen sein, manchmal kann man auch in lockerer Runde beieinander stehen und zusammen lachen. Diskussionen mit dem Lover führen zu nichts. Erste Regel im Verhältnis: Nicht Verlieben!","11-31":"Aus einer Diskussion gehst du als Sieger hervor. Dass gibt dir Kraft und neues Selbstbewusstsein. Genieße diesen Erfolg, du hast es verdient.","11-32":"Es fällt dir leicht, Menschen zum Lachen zu bringen, es steckt dir im Blut, nutze diese Fähigkeit in den kommenden Tagen zu deinem Vorteil. Mit deiner Intuition hast du genau die richtige Spur. Wenn du nun noch die richtigen Menschen zur richtigen Zeit ansprichst, steht der Erfüllung deines Wunsches oder der Erreichung deines Ziels nichts mehr im Wege.","11-33":"Gespräche sind der Schlüssel. Hier muss geredet werden, jetzt! Finde die richtigen Worte und rede nicht um den heißen Brei herum. Wenn es beim ersten Mal nicht klappt, versuche es noch einmal.","11-34":"Wenn du gerade Streit hast, wird dieser Streit noch heftiger. Es kann sogar so weit gehen, dass ihr euch in dieser Diskussion mit euren Worten verletzt. Man sagt: Bei Geld hört die Freundschaft auf.","11-35":"Schlimmer als die eigentliche Trennung ist die innerliche Kündigung von jemandem oder etwas. In dieser Situation oder Beziehung hat einer der Beteiligten schon innerlich abgeschlossen, es muss nur noch ausgesprochen werden, aber das kann sich hinziehen.","11-36":"Ein alter Streit um etwas oder jemanden kann nun endlich abgeschlossen werden. Entweder bekommst du die lange erhoffte Entschuldigung oder du bekommst die notwendige Reife um Gnade vor Recht ergehen zu lassen.","12-13":"Vielleicht wolltest du in aller Stille neu beginnen, mit jemandem oder etwas. Dennoch ist es nicht unentdeckt geblieben, man redet bereits davon.","12-14":"Glaub nicht alles, was man dir erzählen will. Diese Nachricht kann schlicht weg gelogen sein. Wenn du dennoch darauf eingehst, haben die anderen ihr Ziel erreicht.","12-15":"Es folgen Gespräche mit einer autoritären Person. Das kann ein Chef sein oder eine Vaterfigur. In jedem Falle wird es aufregend für dich, da du nicht immer so sein kannst, wie du wirklich bist.","12-16":"Wenn du lernst, dich auf deine Intuition zu verlassen, wird es ruhiger zugehen. Es funktioniert schon alles, so wie du es wünscht.","12-17":"Am besten gefallen uns Veränderungen, wenn alles so bleibt wie es ist. Das ist auch der Grund, warum mit diesen Veränderungen Stress und Hektik auf dich zukommen.","12-18":"Vielleicht machst du dir zu viele Sorgen um einen Freund, weil du schon siehst, worauf es hinaus läuft.","12-19":"Wenn du selbstständig bist, solltest du mehr über dein schönes Projekt reden: Mach eine Promotion Tour, das bringt neuen Schwung in die Sache. Tue Gutes und rede darüber. In Behördenangelegenheiten könnte es jetzt stressig werden. Achte bitte darauf, dass du die richtigen Worte wählst, das spart Kraft.","12-20":"Hier finden viele Gespräche mit vielen Leuten statt. Das kann in einem Callcenter ebenso der Fall sein, wie auf einem Speed Dating.","12-21":"Vielleicht bist du schon etwas länger wund an den Nerven, so dass du öfter als nur einmal keine Lust hast, ans Telefon zu gehen. Das ändert aber an der Situation nichts.","12-22":"Es ist immer gut, sich verschiedene Meinungen einzuholen, wenn man eine wichtige Entscheidung trifft. Geh nur niemandem mit deiner Fragerei auf die Nerven, sondern interessiere dich auch für die Belange von anderen.","12-23":"Der Anruf auf den du wartest, wird nicht kommen. Jemand nervt dich am Telefon. Vielleicht handelt es sich um einen anonymen Anruf oder jemanden, der dich nicht loslassen kann.","12-24":"Gerade beim Chatten oder beim Versenden von SMS- Nachrichten, kann es zu Missverständnissen kommen. Diese Schwierigkeiten sind aber nur von kurzer Dauer.","12-25":"Momentan ist es wirklich stressig. Viele Dinge wollen erledigt sein, viele neue Verbindungen eingegangen und viele alte Verbindungen gepflegt. Denke immer daran: Je mehr man besitzt um so mehr wird von einem abverlangt, ganz gleich auf welcher Ebene.","12-26":"Manchmal ist es einfach besser, erst nach dem Deal über die Geschäfte bzw die Erfahrungen zu sprechen, die wir gemacht haben. Zu viele Köche verderben den Brei. Aufregung im Studium oder in der Schule. Vielleicht hast du das Gefühl, in einer ewigen Tretmühle gefangen zu sein, oder dass es einfach ein zu komplexes Thema zum Lernen ist. Diese Nervosität legt sich bald.","12-27":"Durch einen Brief oder eine Nachricht machst du dir zusätzliche Gedanken. Diese Sorgen sind aber nicht von langer Dauer.","12-28":"Als Person: Dieser Mann kann gut mit Worten umgehen. Das schmeichelt und tut gut. Überlege nur einmal, warum er gelernt hat, so viele Komplimente zu machen und wie und wo er das wohl geübt haben mag. Als Situation: Du hast dich gut über dein Thema informiert und bist jetzt dazu in der Lage, andere von jemandem oder etwas zu überzeugen. Auch wenn dich der Gedanke daran vielleicht nervös macht, starte jetzt!","12-29":"Als Person: Diese Dame ist sehr aufgeregt und kann daher nicht immer sie selbst sein. Wenn ihr euch näher kennen lernt, legt sich die Nervosität und ihr bezauberndes, wahres Ich kommt zu Tage. Als Situation: Auch wenn dich das Warten nervös macht, du solltest nichts überstürzen, bis sich die Situation zu deinen Gunsten ändert.","12-30":"Was wir begehren scheint sich immer weiter von uns weg zu bewegen. Egal um was es sich handelt, es gibt etwas in deinem Leben, das du dir so sehr wünscht, dass du fast verrückt wirst. Je schneller du dich beruhigen kannst, um so eher wirst du es erreichen.","12-31":"Manchmal macht es so richtig Spaß, aus Herzenslust zu tratschen. Hier erfährst du sogar noch von Dingen, die für deine Sache hilfreich sind. Das macht doppelt glücklich.","12-32":"Diese Gespräche bringen dich richtig weiter! Du bist deiner Intuition gefolgt und hast, bewusst oder unbewusst, alles richtig gemacht. Jetzt wirst du schon bald deinen Ruhm einfahren können und die Anerkennung bekommen, die du dir wünscht.","12-33":"Wenn du in eine Diskussion gehen willst oder musst, hast du jetzt die passenden Argumente und die richtigen Worte zur Hand. Du wirst in diesen Gesprächen erfolgreich sein.","12-34":"Was immer dir im Moment zu schaffen macht oder dir Sorgen bereitet, wird sich in den kommenden Tagen noch verstärken. Zum Glück sind diese Schwierigkeiten nicht von Dauer. Ziehe die richtigen Konsequenzen daraus.","12-35":"Vielleicht hast du momentan Schwierigkeiten, dich auf deine Arbeit oder auf das, was du wirklich tun solltest, zu konzentrieren. Schreibe dir einmal auf, was dich so alles bewegt, damit es nicht noch mehr Schwierigkeiten gibt.","12-36":"Auf diesen Anruf oder auf diese Nachricht hast du mit pochendem Herzen gewartet. Es könnte der Beginn von etwas ganz Großem sein.","13-14":"Es kann sein, dass du eine Rivalin an deiner Seite hast. Sie geht dabei klug ans Werk und vielleicht stellt sie sich als Freundin vor. Sei wachsam.","13-15":"Du bist auf mentaler Ebene stärker, als du vielleicht denkst. Wenn eine Situation deine ganze Kraft erfordert, sei gewiss, dass du noch einiges an Reserven zur Verfügung hast.","13-16":"Ein lang gehegter Wunsch geht jetzt in Erfüllung, ganz sicher, sanft und schnell. Du hast deine Sache bis hier hin sehr gut gemacht, du darfst dir etwas wünschen und dein Wunsch wird in Erfüllung gehen.","13-17":"Hier wird eine Schwangerschaft angezeigt. Das kann im wahrsten Worte so gemeint sein, aber auch im übertragenen Sinne: Du hast eine neue Idee zu deiner momentanen Situation, oder du gehst mit einem neuen Projekt schwanger.","13-18":"Hier kann eine junge Frau mit einem Hund gemeint sein, der du demnächst begegnest und die für dich in dieser Situation wichtig sein können. Ein guter Freund geht eine neue Beziehung ein. Es wird dich selbst betreffen.","13-19":"Wenn es sich um Behördenangelegenheiten handelt, dann ist hier speziell das Jugendamt gemeint, das in einer bestimmten Situation wichtig sein wird. Wenn du in einer Situation fest steckst, in der du dich vielleicht sehr einsam fühlst, könnte ein spielerischer Umgang und kindliche Leichtigkeit ein Weg hinaus bedeuten.","13-20":"Hier geht es um eine Schule und um das, was man darin lernen kann. Im weitesten Sinne auch um die Lernaufgaben, die dir das Leben stellt. Kinder wissen, dass sie das zum Leben wirklich Notwendige von ihren Eltern bekommen. Sie sorgen sich nicht. Kinder sind hemmungslos ehrlich und sie gehen auf jeden offen zu, wenn sie noch keine schlechte Erfahrungen gemacht haben. «Werdet wie die Kinder», sagt Jesus in der Bibel. Dieser Ratschlag hat mehrere Aspekte.","13-21":"Vielleicht warst du in einer Angelegenheit etwas zu blauäugig. Damit hast du dir selbst den Weg verbaut, deine Ziele zu erreichen. Jetzt wird es entweder schwierig oder du beginnst noch einmal von Neuem.","13-22":"Wenn dir eine Entscheidung einfach nicht gelingen will, solltest du jetzt spielerisch an die Sache heran gehen. Du kannst würfeln oder das Los entscheiden lassen.","13-23":"Wenn du etwas Neues am Start hast, auf welcher Ebene auch immer, machst du dir einfach zu viele Sorgen darum. Diese Sorgen sind reine Energiefresser und zerstören den Spaß des Neubeginns und führen zu nichts.","13-24":"Dein Herz schlägt in den höchsten Tönen und wenn du nicht gerade frisch verliebt bist, so fühlt es sich eben fast so an. Dieser Neuanfang lässt dein Herz höher schlagen.","13-25":"Dieser Vertrag, diese Bindung oder Beziehung kommen überraschender Weise doch noch zu Stande.","13-26":"Du kennst nicht alle Hintergründe zu dieser Situation. Das könnte zu einem Fehlurteil führen, was weitreichende Konsequenzen haben kann.","13-27":"Mit diesen neuen Nachrichten hast du nicht gerechnet, sie kommen so überraschend und absolut positiv. Du erhältst eine Nachricht von einer jungen Dame, mit der du so nicht gerechnet hast. Du wirst überrascht sein.","13-28":"Als Person: Dieser Herr ist noch recht unreif, etwas naiv und albern. Als Situation: Es geht lustig zu und man sollte in dieser Angelegenheit nicht alles so ernst nehmen. Es geht viel um Selbstdarstellung auf den verschiedensten Ebenen.","13-29":"Als Person: Diese Dame ist noch recht jung und unerfahren, eventuell etwas unreif. Als Situation: Du wirst abwarten müssen, ehe sich etwas Neues ergibt. Es kommen gute Gelegenheiten auf dich zu.","13-30":"Jemand oder etwas ist zu frühreif. (Vielleicht sogar zu früh schwanger.) Vielleicht hast du dich zu schnell darauf eingelassen und musst jetzt mit den Konsequenzen rechnen.","13-31":"Du wirst noch einmal ganz von vorne Anfangen und diesmal wird es ein grandioser Erfolg mit einem überraschend gutem Ergebnis.","13-32":"Alles was du suchst ist Liebe und Anerkennung. So lang du nicht in der Lage bist, dir selbst zu geben, was du brauchst, wirst du von anderen nie genug davon bekommen.","13-33":"Im übertragenen Sinne bedeutet das, was immer dir momentan sehr wichtig ist, jetzt ist die Zeit, dass es sich in der materiellen Welt zeigt. Gutes Gelingen.","13-34":"Richte deine Aufmerksamkeit auf die Dinge in deinem Leben, die dir gut gelingen. 1. Wirst du überrascht sein, wie viele Dinge das eigentlich sind und 2. werden dadurch immer mehr und mehr Dinge so funktionieren, wie du es dir wünscht.","13-35":"Für ein Kind ist der heimatliche Hafen ein Ort der Sicherheit und des Schutzes. Schau, ob du nicht schon den Kinderschuhen entwachsen bist und es Zeit wird für eine neue Orientierung.","13-36":"Dieses “Baby” hat es in sich. Was immer dir auch in die Arme gelegt wird, sei es eine neue Beziehung zu jemandem oder zu etwas, oder ein neues Projekt oder wirklich ein neues Baby, es wird deine Nerven arg auf die Probe stellen und du wirst dich von Schicksal geprüft fühlen.","14-15":"Etwas, wovor du großen Respekt hast, ist nicht so gut, so groß oder so bedeutend, wie du vielleicht glauben magst. Prüfe deine Einstellung, dann hast du es leichter. Wenn du jemanden oder etwas von vorn herein ablehnst, kann dir eine wichtige Erfahrung verloren gehen.","14-16":"Du wirst eine sehr kluge und bedeutende Eingebung haben, die dir hilft, dein Ziel zu erreichen. Schau, ob dein Ziel wirklich zum höchsten Wohle aller ist, dann kannst du deinen Erfolg am Ende aus tiefster Seele genießen.","14-17":"Es ist ein kluger Plan, der diese Veränderung herbeiführt. Auch wenn es nicht das Ergebnis ist, das du erwartet hast, wird es am Ende das beste für alle sein.","14-18":"Ein Freund verfolgt seine eigenen Ziele, die nicht immer mit deinen Wünschen überein stimmen. Jemand versucht sich bei dir einzuschmeicheln und erweist sich als falscher Freund. Verlass dich nicht auf ihn.","14-19":"Wenn es sich um Behördenangelegenheiten handelt, so ist hier meistens das Finanzamt gemeint. Falsche Handlungs- und/ oder Denkweisen können dich mehr und mehr in die Isolation führen.","14-20":"Um dein Leben nach den Wünschen deiner Seele zu gestalten, befindest du dich absolut in der falschen Gesellschaft, am falschen Platz. Vielleicht weißt du schon, was du ändern könntest oder solltest.","14-21":"Lügen haben kurze Beine. Auch wenn man nicht ganz ehrlich zu sich selbst ist, verbaut man sich Möglichkeiten und kann nicht sehen, was einen wirklich weiter bringen kann.","14-22":"Jetzt eine endgültige Entscheidung zu treffen wäre absolut unklug. Verschiebe die Entscheidung und lass die Dinge erst einmal in Ruhe auf dich zu kommen. Was geschehen soll, passiert doch, du brauchst dich nicht so anstrengen.","14-23":"Das, was in dieser Situation nicht stimmt, kommt jetzt ans Licht. Auch wenn es vielleicht weh tut und eine schmerzliche Erfahrung ist, so bringt sie doch auch Erleichterung mit sich.","14-24":"Vielleicht hast du dein Herz an die falschen Personen oder Dinge gehängt. Jetzt bekommst du die Möglichkeit, das zu erkennen.","14-25":"Durch jemanden oder etwas, zu dem du eine enge (vertragliche) Bindung hast, bist du betrogen worden. Das wirst du jetzt erkennen und die richtigen Konsequenzen daraus ziehen.","14-26":"Manchmal macht es richtig Spaß, jemandem hinterher zu spionieren, vielleicht einen Griff in die Jackentaschen, ein Blick ins Handy oder auf den PC. Nur denke immer daran: Der Lauscher an der Wand hört seine eigene Schand. Wenn es dir ein Gefühl der Sicherheit gibt, kannst du dir einen Spickzettel für deine Prüfung oder deinen Test schreiben. Auch wenn du ihn letztlich nicht benutzen wirst, kannst du dich so leichter an die wichtigsten Punkte erinnern.","14-27":"Dieser Brief/ diese Nachricht war eigentlich nicht für dich bestimmt und was du erfährst muss nicht der Wahrheit entsprechen. Versuch es zu relativieren.","14-28":"Als Person: Dieser Herr ist sehr klug und wenn er vielleicht auch nicht direkt als Lügner zu bezeichnen ist, so hat er doch die Gabe, die Wahrheit so hinzubiegen, dass sie für ihn passend ist. Als Situation: “Was nicht passt, wird passend gemacht!” Auch wenn es nicht so gut läuft, wie geplant, kannst du doch nach den Aspekten suchen, die für dich in diesem Moment passend sind. Das bringt dir deine Lebensfreude zurück. Zum Beispiel: Wenn du ein Picknick geplant haben solltest und es regnet, kannst du dich darauf besinnen, dass ein gemütlicher Nachmittag auf dem Sofa auch sehr romantisch sein kann.","14-29":"Als Person: Diese Dame sagt viel, nur um des lieben Friedens willen. Das kann dazu führen, dass sie mal explodiert, wenn es ihr zu viel wird. Als Situation: Vielleicht siehst du die Dinge falsch, weil dir dein brillanter Verstand aus seinen früheren Erfahrungen heraus einen Streich spielt und die Tatsachen verzerrt darstellt. Warte erst einmal ab, ob wirklich das als nächstes passiert, das du erwartest.","14-30":"Nicht immer sind die Komplimente, die Zuneigung und die Anerkennung die wir erhalten, so uneigennützig verschenkt, wie wir es hoffen. Nicht immer werden wir um unserer Selbst willen gemocht.","14-31":"Tief im Herzen hinterlässt falsche Freundlichkeit einen dunklen Schatten. Zum Beispiel wenn unsere Kinder besonders freundlich zu uns sind, fragen wir automatisch: Was willst du? So schau auch hier nach, was dahinter steckt.","14-32":"Freu dich nicht zu früh, noch ist der Erfolg nicht wirklich eingefahren, das Ziel noch nicht sicher erreicht, auch wenn alles schon in trockenen Tüchern zu stecken scheint. Dieser Erfolg hat einen bitteren Beigeschmack.","14-33":"Manchmal lügen Menschen, um Schlimmeres zu verhindern. Auch wenn es nicht ganz der Wahrheit entspricht, was da gesagt oder getan wird, hast du jetzt die Möglichkeit, eine Episode abzuschließen. “Du hast recht und ich meine Ruh.” Das erspart dir eine Menge Stress.","14-34":"Etwas oder jemand, der dir sehr wichtig ist, geht dir verloren. Vielleicht wird es dir sogar gestohlen oder gewaltsam entrissen.","14-35":"Du hast dir falsche Hoffnungen gemacht, dein Ziel zu erreichen, deinen Wunsch nach Sicherheit zu erfüllen. Denke immer daran, dass eine Enttäuschung auch immer das Ende einer Täuschung ist.","14-36":"Wenn man entdeckt, dass man auf Sand gebaut hat und das ganze Konstrukt, was so lange und so mühsam aufrechterhalten wurde, unter den Händen zusammen bricht, ist das ein schmerzlicher Prozess. Allerdings bringt es auch Raum für einen neuen Anfang.","15-16":"Jetzt ist die Zeit für einen Durchbruch in einer für dich sehr wichtigen Angelegenheit. Was du auch vor hast, du hast alle Kraft zur Verfügung und das Universum ist auf deiner Seite. Besser geht es nicht.","15-17":"Relationen verändern sich auf dramatische Weise und du bekommst eine andere Sicht auf die Dinge. So verliert etwas, das dir vorher sehr groß und mächtig erschien, an Dominanz und es werden andere Dinge wichtig.","15-18":"Du bekommst in dieser Situation hilfreiche Unterstützung von einem Freund. Sei es eine starke Schulter zum Anlehnen, die du brauchst oder Schutz vor unfreundlich gesonnenen Mitmenschen, es wird dir Hilfe zuteil.","15-19":"Wenn es sich um Behördenangelegenheiten handelt, so hat hier ein Richter Entscheidendes dazu beizutragen. Die Einsamkeit kann zu einem mächtigen und gefährlichen Gegner heranwachsen und eiskalt nach deinem Herzen greifen. Wenn du selbstständig für etwas oder jemanden arbeitest, so bekommst du jetzt die nötige Kraft, um erfolgreich zu sein. Wenn du selbstständig für etwas oder jemanden arbeitest, so bekommst du jetzt die nötige Kraft, um erfolgreich zu sein.","15-20":"Jemand wird vorgeführt und der Lächerlichkeit Preis gegeben, trotz oder gerade wegen seiner physischen oder mentalen Stärke. Kein schöner Anblick und du solltest dich auch zurück halten. Hochmut kommt vor dem Fall.","15-21":"Du hast jetzt die nötige Kraft, den weiten Weg bis zu deinem Ziel auf dich zu nehmen. Auch wenn es hart wird, so wirst du doch am Ende erfolgreich sein und als Sieger hervor gehen.","15-22":"Wenn du zu viele Dinge auf einmal in Angriff nehmen willst, verteilt sich deine Energie auch auf diese vielen Dinge und so kann es unnötig schwer werden, Ziele zu erreichen. Setze Prioritäten.","15-23":"Zweifel ist die Macht, die letztlich die Kraft hat, unseren Erfolg zu vereiteln. Öffne nicht dem Zweifel die Tür, sondern konzentriere dich auf die Dinge, die sicher, sanft und schnell zu erreichen sind. Das bringt dir Sicherheit.","15-24":"Du hast ein großes Herz, schütze es vor Eifersucht, Wut und Ärger, denn sie können in einem großen Herzen große Wunden schlagen.","15-25":"Diese Verbindung ist von großer Kraft und Beständigkeit. Nichts kann sie so leicht erschüttern und trägt zum Wachstum beider Partner bei, auf welcher Ebene auch immer (geschäftlich oder privat).","15-26":"Aus manchen Büchern können wir große Kraft schöpfen und neuen Lebensmut. Sie können uns helfen, uns selbst zu schützen, zu stärken und mit neuem Elan unser Ziel zu verfolgen.","15-27":"Vielleicht bekommst du einige Chatnachrichten, die dich anregen und dich ins Schwärmen bringen. Es handelt sich hier um Nachrichten von einer einflussreichen und autoritären Person, du kannst also noch etwas weiter schwärmen.","15-28":"Als Person: Dieser Mann scheint groß und mächtig zu sein oder zumindest möchte er das, gelingt es ihm nicht, reagiert er aufgeregt und jähzornig.","15-29":"Als Person: Diese Dame neigt dazu, mit ihrem eigenen Maß zu messen, das kann dazu führen, dass sie ihre Aufmerksamkeit nicht immer gerecht verteilt. Als Situation: Es herrscht eine explosive Stimmung und ein kleiner Funke würde ausreichen, um einen Flächenbrand zu initiieren.","15-30":"Das jemand oder etwas, das so groß und mächtig zu sein scheint, so lieb und harmoniebedürftig sein kann, hattest du sicher nicht erwartet.","15-31":"Ein großer, satter Erfolg wartet auf dich. Es scheint, als würden all deine Träume wahr. Du wirst damit angeben können… (nicht das du das tun solltest.)","15-32":"Dieser Erfolg und diese Anerkennung beruhen auf eine lange Zeit harter Arbeit und sicher auch auf einige Entbehrungen. Du hast viel dafür getan und diesen Erfolg mehr als verdient.","15-33":"Du befindest dich auf der Zielgeraden. Jetzt kann einfach nichts mehr schief gehen. Du wirst dein Ziel erreichen, sicher, sanft und schnell.","15-34":"Du strahlst Kraft und Stärke aus und das macht es dir leicht, erfolgreich zu sein. Was immer du dafür getan hast, mach so weiter, denn das bringt dir Glück.","15-35":"Du bist bereit, hart zu arbeiten und gute Leistungen zu erbringen, um dein Ziel zu erreichen. Achte allerdings darauf, dich nicht all zu sehr zu verausgaben.","15-36":"Jemand oder etwas, durch das Kraft, Stärke und Schutz repräsentiert wird, hat einen großen Einfluss auf dein weiteres Schicksal. Es ist unausweichlich und wird dich letztlich auf eine neue Stufe stellen.","16-17":"Du hast die Ursache an der Wurzel verändert, jetzt kann sich diese Veränderung nach und nach auf allen Ebenen durchsetzen.","16-18":"Jemand in deinem Freundeskreis ist von außerordentlichem Glück gesegnet. Was du auch vor hast, das Universum ist dein Freund und du kannst auf seine Unterstützung rechnen.","16-19":"In Behördenangelegenheiten geht es jetzt voran und du hast gute Chancen, deine Absichten durchzusetzen. Deine Einsamkeit hat ein Ende, weil du gelernt hast, dem Augenblick zu vertrauen und ihn zu genießen. Du kannst nicht in der Zukunft glücklich werden, in der Vergangenheit auch nicht, nur jetzt. In der selbstständigen Arbeit wirst du erfolgreich sein und die Dinge gehen dir leicht von der Hand.","16-20":"Wenn du einen Auftritt vor einem größeren Publikum haben solltest, so wirst du strahlenden Erfolg haben, solltest du dir diesen Auftritt erst wünschen, so wird dieser Wunsch nun bald in Erfüllung gehen. Dabei kann es sich um ein Seminar ebenso gut handeln, wie um einen Auftritt bei DSDS, wenn du dies anstreben solltest.","16-21":"Alles was dir bei der Erreichung deines Ziels im Wege stand, wird nun einfach aufgelöst und zur Seite geschoben, sicher, sanft und schnell.","16-22":"Bei deiner Entscheidung hattest du ein glückliches Händchen und hast die richtige Wahl getroffen, das zahlt sich jetzt aus.","16-23":"Was du auch nutzt, um deinen Blick von der “schlimmen, schmerzlichen Wirklichkeit” abzulenken (Computerspiele, Medikamente, Alkohol, Sport, Essen…), denke immer daran: Das Problem verschwindet nicht, nur weil man den Kopf in den Sand steckt.","16-24":"Unglaublich glückliche Zeiten erwarten dich und nichts und niemand wird dich aufhalten können. Du kannst dich also voll und ganz dem Genuss hingeben.","16-25":"Du fühlst dich den höheren Ebenen verbunden. Jetzt kommt die Zeit, da du ein Echo aus dem Universum erwarten kannst: Du wirst geführt.","16-26":"Wenn du mit dem Gedanken spielst, ein Buch zu schreiben und zu veröffentlichen, solltest du jetzt damit anfangen. Die Worte werden dir nur so zufliegen. Du hast die Gabe, auch die geheimsten Gedanken und Anliegen deiner Mitmenschen zu erkennen und zu verstehen. Dieses Talent ist ausbaufähig und sollte gepflegt werden.","16-27":"Mit dieser Nachricht bist du mehr als zufrieden. Sie fällt genau so aus, wie du es haben wolltest. Du wirst erfolgreich sein.","16-28":"Als Person: Dieser Herr ist sehr intuitiv, ja vielleicht schon medial veranlagt. Er ist auf Erfolgskurs und wird es auch weiterhin bleiben. Als Situation: Es wird jetzt schnell voran gehen und du wirst vielleicht erstaunt sein, wie erfolgreich du dabei bist. Werde aktiv, du bekommst alle notwendige Unterstützung.","16-29":"Als Person: Diese Dame ist auf mysteriöse Weise sehr erfolgreich. Auch wenn sie nicht leicht zu durchschauen ist, so macht doch auch gerade das Geheimnisvolle den Reiz aus. Als Situation: Wenn du vielleicht auch noch nicht genau weißt, aus welcher Richtung dir Unterstützung zu Teil wird, du kannst in Ruhe abwarten, Hilfe ist unterwegs.","16-30":"Wenn es in der Vergangenheit Schwierigkeiten in der Familie gegeben hat, so wird es sich jetzt harmonischer gestalten. Dieses Ereignis ist wie einmalig schöner Super O! Beneidenswert! Genieße die Zeit und lass dich mal so richtig verwöhnen.","16-31":"Unglaubliche Glücksfälle reihen sich jetzt aneinander. Dinge, die du dir vorgenommen hast, erledigen sich fast wie von allein und du hast eine außerordentliche Glückssträhne. Du wirst dir einige Wünsche erfüllen können.","16-32":"Durch vergangene Aktivitäten wurde der Weg zum sozialen Aufstieg geebnet. Vielleicht lernst du die richtigen Leute kennen, die deine Talente zu schätzen wissen. Jedenfalls geht es jetzt aufwärts.","16-33":"Du kannst dir deines Erfolges schon sicher sein. Du wirst alle nötigen Informationen erhalten, die richtigen Schlüsse daraus ziehen und dadurch viel Klarheit erhalten. Glückliche Umstände bringen dich an dein Ziel. Wenn du gerade mit jemanden oder etwas einen Neuanfang startest, tragen dich eine Menge glücklicher Umstände auf Wolke 7.","16-34":"Neue, anregende Ideen und Eingebungen bringen dich in dieser Situation an dein Ziel. Achte auf deine Träume oder besuche Orte, die dich inspirieren.","16-35":"Vielleicht fühlst du dich manchmal verloren und ganz allein im großen Sternen- Universum. Denke immer daran: Du kannst Nähe zu einem anderen Menschen aktiv herbei führen, indem du etwas mit ihm gemeinsam unternimmst oder dich für seine Sachen interessieren (auch wenn es sich mal um Fußball oder etwas in der Art handeln sollte).","16-36":"Um eine bestimmte Erfahrung zu machen, hatte deine liebe Seele dein Licht etwas gedimmt, dein Energiepotential etwas herunter geschraubt. Diese Zeit ist nun vorbei","17-18":"In deinem Freundeskreis stehen Veränderungen an, die dich in dieser Situation berühren. Vielleicht das neue Bekannte zu Freunden, oder einige alte Freunde aus den Augen verloren werden. Durch die Unterstützung eines Freundes ändert sich die Situation grundlegend. Du kannst auch um Hilfe bitten und dich beratschlagen.","17-19":"Wenn du dich bislang sehr einsam gefühlt hast, kannst du jetzt der Einsamkeit entrinnen. Wenn du bislang eher selbstständig gearbeitet hast, wirst du jetzt die Erfahrung von Teamwork machen können. Und wenn du dich zuvor sehr stark in deiner Gemeinschaft engagiert hast, dann ist es jetzt an der Zeit, sich zurück zu ziehen.","17-20":"Wenn du eine Reise planst, könnte eine Clubreise genau nach deinem Geschmack sein. Animateure/innen machen einen tollen Job und man fühlt sich gut und umsorgt und oft auch geschmeichelt. Wenn du noch nicht darüber nachgedacht hast, ist es jetzt an der Zeit, dich einmal verwöhnen zu lassen, du hast es verdient.","17-21":"Druck erzeugt immer einen Gegendruck und je mehr du versuchst, eine Veränderung zu erzwingen, um so stärker wird das Universum dagegen halten. Suche nach einer anderen Lösung, denn dieses Tauziehen verlierst du.","17-22":"Du hast die richtige Entscheidung getroffen, und wenn du dich nicht entscheiden konntest, hat das Universum für dich eine glückliche Wahl getroffen. Jetzt bringen sie den erhofften Wandel.","17-23":"Die Veränderungen gehen, wenn überhaupt nur sehr langsam voran und sie bringen kaum den erwünschten Effekt. Schau, was deiner reinen Absicht den Erfolg nimmt? Wünschst du es dir zu sehr? Zweifelst du am Erfolg? Oder traust du dir selbst oder anderen nicht zu, mit den erhofften Veränderungen zurechtzukommen?","17-24":"1000 Mal berührt… 1000 Mal ist nichts passiert… Dein Herz ist im Wandel. Jemand oder etwas, dass du schon lange weißt oder kennst, berührt dein Herz nun auf eine andere, sehr besondere Art.","17-25":"Diese Beziehung zu jemandem oder etwas verändert sich jetzt: Offene Verträge werden abgelöst, Versprechen eingehalten und man fügt sich ohne Not in seine Verpflichtung.","17-26":"Nun ist die Katze aus dem Sack und es müssen die Konsequenzen gezogen werden. Vielleicht hast du auch eine Prüfung oder einen Test gut bestanden, so dass du dich nun deiner Berufung widmen kannst, vielleicht ist es an der Zeit, ein Testament zu ändern. In jedem Falle ist es eine Zeit, die viel (aufregend) Neues mit sich bringt.","17-27":"Diese Nachricht hast du vielleicht schon sehnsüchtig erwartet. Nun ist es an der Zeit loszulegen und die Veränderungen anzuschieben. Es verändert sich zu deinen Gunsten.","17-28":"Als Person: Dieser Herr ist im positivsten Wortsinne sehr flexibel, man könnte auch behaupten, dass er sein Mäntelchen oft in den Wind hängt. Eine Eigenschaft, die man durchaus zu schätzen wissen könnte, wenn man sich darauf verlassen kann. Als Situation: Wenn du dich mit dem Gedanken trägst umzuziehen, dann kannst du jetzt den nötigen Elan aufbringen und alles in die Wege leiten und organisieren. Auch bei Veränderungen persönlicher Art wirst du nun erste Erfolge erzielen.","17-29":"Als Person: Diese Dame hat es geschafft, dich mit ihren vielen Facetten beinahe um den Verstand zu bringen. Sie ist geheimnisvoll und überrascht dich jedes mal aufs Neue. Als Situation: Es wäre wirklich hilfreich für dich, wenn du diese Situation besser einschätzen könntest. Sei flexibel, damit du nötigenfalls schnell reagieren kannst.","17-30":"Das Verhältnis zu einem Mann verändert sich. Vielleicht siehst du ihn nun mit anderen Augen, erkennst ihn so, wie er wirklich ist. Das kann durchaus einen positiven Effekt haben.","17-31":"Wenn die Störche in den Süden ziehen, bedeutet es, dass der Winter nicht mehr weit ist. Du hast jetzt noch die Möglichkeit und die notwendige Energie, dich für die kalte Jahreszeit zu wappnen.","17-32":"Es sind Veränderungen, die tief in deiner Seele ihren Ursprung genommen haben, jetzt ist es an der Zeit, dass sie sich in der materiellen Welt manifestieren. Es scheint also nur so, als das es über Nacht und plötzlich zu diesem Wandel gekommen ist.","17-33":"Wie ein Zahlencode an einem Tresor hattest du viele Aufgaben zu erfüllen, um diese Veränderungen herbei zu führen. Jetzt bist du in der Lage, die Tür zu öffnen und einen neuen Raum mit neuen Erfahrungen zu betreten.","17-34":"Wenn durch diese Reise oder diese Veränderung etwas an Unruhe in dein Leben getreten ist, dann kann sich dieser Zustand noch etwas ausdehnen.","17-35":"Wenn du dich von etwas lösen möchtest, das schon lange an dir hängt, kann es dir jetzt gelingen. Wenn du eine Veränderung im Bereich deiner persönlichen Arbeit erreichen willst, hat es jetzt gute Chancen zu gelingen.","17-36":"Diese Veränderung ist unausweichlich, was du auch tust, um sie zu umgehen oder vielleicht sogar zu verhindern, es wird dir nicht gelingen.","18-19":"Ein Freund fühlt sich einsam. Vielleicht erhofft er sich mehr Nähe und Unterstützung von dir, jetzt, da er in Not ist. Auch wenn es egoistisch zu sein scheint, solltest du ihm diesen Dienst nicht verweigern. Ihr könnt darüber reden, wenn es ihm besser geht.","18-20":"Du triffst einen Freund auf einer Veranstaltung, in einer Disco oder in einer Kneipe wieder. Vielleicht habt ihr euch schon lange nicht gesehen und du fragtest dich, wie es ihm geht.","18-21":"Was sich dein Freund nennt, handelt lieber nach seinem eigenen Ermessen, als in deinem Sinne. Das mag ihm als Sturheit durchgehen, vielleicht kann er aber auch nicht anders.","18-22":"Dein Freund kann dich bei dieser Entscheidung unterstützen, da er eine ähnliche Erfahrung auch schon gemacht hat. Achte darauf, dass bei deiner Entscheidung deine Freunde nicht auf der Strecke bleiben, du würdest sie irgendwann sehr vermissen.","18-23":"Vielleicht hast du einem Freund oder einer Freundin gegenüber ein schlechtes Gewissen oder ein ungutes Gefühl. Auch wenn du vielleicht nicht genau weißt, wie es dazu gekommen ist, helfen kleine Geschenke doch zur Erhaltung der Freundschaft.","18-24":"Diese Freundschaft ist groß und herzlich, und es kommt euch vor, oder vielleicht ist es auch so, als dass ihr euch schon ein ganzes Leben lang kennt. Pflege diese Freundschaft und respektiere den Rat, den du bekommst.","18-25":"Dieser Vertrag wird lange Bestand haben und sehr viele Annehmlichkeiten für dich bringen. Du hast alles richtig gemacht!","18-26":"Dieses Geheimnis wird sich noch lange nicht aufklären. Es kann sein, dass du deinen Freund oder deine Freundin lange nicht zu sehen bekommst, da er/ sie für das Studium lernt, oder du. Ein Freund hat ein Geheimnis und trägt sich schwer damit.","18-27":"In dieser Angelegenheit bekommst du Nachricht von einem Freund. Vielleicht bekommst du Hilfe angeboten oder eine Einladung zur Aufmunterung… In jedem Falle solltest du das Angebot annehmen.","18-28":"Als Person: Dieser Herr ist sehr freundlich, treu und zuverlässig. Etwas langweilig vielleicht, aber dennoch treu und zuverlässig. Als Situation: Viel Action ist in diesem Moment nicht zu erwarten, alles läuft nach Plan, auch wenn es dir etwas zu lang dauert, schau was du unternehmen kannst um es voran zu bringen.","18-29":"Als Person: Diese Dame ist sehr freundlich, lustig, ein echter Kumpel. Sie hat alles, was ein Männerherz begehrt. Als Situation: Über einen gewissen Status Quo kommst du in diesem Moment nicht hinweg und du kannst auch nichts dafür tun, dass es sich rasch verändert. Warte es ab.","18-30":"Diese Freundschaft ist sehr harmonisch und liebevoll, es kann sich durchaus auch um eine “Freundschaft Plus” handeln und das ist momentan erfüllend für euch beide.","18-31":"Das ist eine Freundschaft, die glücklich macht. Du schöpfst aus ihr Kraft, Lebensfreude und jede Menge frischer, positiver Energie! Jetzt ist es an der Zeit aufzutanken.","18-32":"Lass dich von deinen Freunden nicht runter ziehen! Auch wenn es gut sein soll, auch mal Schwäche zu zeigen und sich seiner Gefühle nicht zu schämen, so ist es dennoch kein Zeichen einer besonders tollen Freundschaft, wenn ihr euch jedes Mal in den Armen liegt und miteinander weint!","18-33":"Irgendwie ist es magisch: Dein bester Freund taucht immer genau dann auf, wenn du seine Hilfe am meisten brauchen kannst. Woher weiß er das nur immer? Du kannst dich auf ihn verlassen.","18-34":"Vielleicht hast du im Moment mehr Unterstützung nötig, als es dir lieb ist. Sei dir nicht zu schade, um Hilfe zu fragen, du wirst sie bekommen.","18-35":"Wenn du deinem Freund bei seinem Unternehmen geholfen hast, wird er auch nicht mehr wie eine Klette an deinen Füßen hängen. Ob er nun eine neue Arbeit sucht oder neuen Anschluss, in jedem Falle ist ihm deine Hilfe sehr wichtig.","18-36":"Dein Verhältnis und deine Loyalität zu einem Freund wird auf eine harte Prüfung gestellt. Wie du diese Prüfung meisterst bestimmt den weiteren Verlauf eurer Freundschaft und deine Integrität.","19-20":"Man kann sich auf der größten Party unglaublich einsam fühlen. Wenn es dir so ergehen sollte, gibt es Möglichkeiten, die Einsamkeit aus dem Herzen zu bekommen, du siehst ja, es liegt nicht daran, dass du alleine bist.","19-21":"Du hast dir eine große Aufgabe vorgenommen und stehst ganz alleine da. Und es kommt noch schlimmer, denn du wirst Konkurrenz haben.","19-22":"Du gehst deinen Weg alleine, du triffst deine Entscheidungen alleine, vielleicht lebst und arbeitest du auch alleine. Überprüfe, ob es wirklich immer nur daran liegt, dass die anderen zu kleingeistig, dumm oder inkompetent sind…","19-23":"Wenn es sich um Behördenangelegenheiten handelt, wird es nicht gut ausgehen. Mit deinem eigenen Zweifel hast du dir die Möglichkeit, Recht zu behalten, verbaut. Du weißt es ja vielleicht: Recht haben und Recht bekommen sind zweierlei Paar Schuh.","19-24":"Wenn du dein Herz weiter so verschließt, wird dir eine große Liebe zu jemandem oder etwas verloren gehen. Auch wenn du vormals unter Verletzungen leiden musstest, denke immer daran: Alleine zu atmen bedeutet noch nicht, am Leben zu sein.","19-25":"Dieser Vertrag wird gelöst. Vielleicht ist er schon abgelaufen, vielleicht stimmen die Konditionen nicht mehr und es wird neu verhandelt und das auf allen Ebenen.","19-26":"Vielleicht fühlst du dich einsam, weil du dich selbst, bewusst oder unbewusst, zum Hüter der Geheimnisse aufgemacht hast, vielleicht auch, weil du denkst, das keiner etwas so gut machen kann, wie du. Du hast Recht, man soll nicht immer alles breit tratschen, aber es gibt auch Themen, über die man smaltalken kann und das trägt dazu bei, Nähe zu spüren.","19-27":"In Behördenangelegenheiten gibt es jetzt neue Nachrichten, in den meisten Fällen positiver Natur. Du bekommst Nachricht von jemandem, der sich (auch) einsam fühlt.","19-28":"Als Person: Dieser Herr könnte ein Beamter sein oder ein Unternehmer, im schlimmsten Falle ist er einfach nur ziemlich egoistisch. Als Situation: Du musst Stärke zeigen und deine Führungsqualitäten unter Beweis stellen, jetzt!","19-29":"Als Person: Diese Dame ist sehr bestimmend und dominant. Sie ist sehr klug und weiß auch viel, dennoch ist sie nicht das Maß aller Dinge. Also: Das muss man mögen. Vielleicht ist sie aber auch so unnahbar, wie Rapunzel. Als Situation: Hier entscheidest nicht du, wo es lang geht, es ist an der Zeit zu lernen, sich unter zu ordnen und im Sinne der Gemeinschaft zu handeln.","19-30":"Jemand oder etwas ist sehr potent, dominant und … heiß! Es wird hoch her gehen, auf welcher Ebene du nun die Karten auch zu deuten versuchst, dieses ist eine sehr fruchtbare Zeit, wenn du verstehst, was ich meine…","19-31":"In Behördenangelegenheiten wirst du nun vom Glück beschienen. Wenn du dich einsam fühltest, so erwärmt das Glück jetzt dein Gemüt, es kommen schönere Tage.","19-32":"Wenn du dich schon zurückziehst, ist es nicht hilfreich, auch noch Trübsal zu blasen. Du oder jemand in deinem persönlichen Umfeld ist oder wird eine berühmte Persönlichkeit.","19-33":"Wenn du dich entschlossen hast, selbstständig ein Ziel in Angriff zu nehmen oder eine Aufgabe zu bewältigen, wirst du nun das notwendige Handwerkszeug zur Verfügung haben.","19-34":"Wenn es um Behördenangelegenheiten geht, so ist hier in der meisten Zeit eine Bank oder allgemein ein Geldinstitut gemeint. Wenn du dich in deinem Herzen einsam und verlassen fühlst, dann wird sich dieses Gefühl noch verstärken oder du konzentrierst dich wieder auf die schönen Dinge im Leben.","19-35":"Bei Behördenangelegenheiten geht es hier vorrangig um das Arbeitsamt oder eine Jobvermittlungsagentur. Du arbeitest hart daran, deiner Einsamkeit zu entfliehen und es scheint, als hätte sich das ganze Universum gegen dich verschworen. Denke immer daran: Alles ist eins- und Einsamkeit nur eine Illusion, wenn auch eine sehr hartnäckige.","19-36":"Deine Seele wünscht sich nichts mehr, als endlich auch mal eine Führungsrolle zu übernehmen. Denke immer daran: Prüfungen besteht man, in dem man sich ihnen stellt.","1-20":"Du kaufst Karten für ein Konzert, bekommst eine Einladung zu einer Gesellschaft oder vielleicht besuchst du auch ein interessantes Seminar.","20-21":"Momentan ist es nicht möglich, auf diese Art erfolgreich zu sein. Ein Aufstieg (gesellschaftlich, beruflich oder privat) muss auf einen späteren Zeitpunkt verschoben werden. Diese Veranstaltung, diese Party oder Feierlichkeit, wird sehr langweilig. Den erhofften Gast wirst du nicht treffen. Es kann sich auch um eine Pflichtveranstaltung handeln.","20-22":"Vielleicht wirst du zu mehreren Veranstaltungen oder Partys zugleich eingeladen, du musst dich entscheiden. Du musst eine Entscheidung laut aussprechen, vielleicht vor mehreren Anwesenden oder auf einer Veranstaltung bekannt geben.","20-23":"Du hast dich auf diese Veranstaltung schon sehr gefreut und vielleicht auch schon einige Vorbereitungen getroffen, jetzt wirst du feststellen, dass sie nicht so läuft, wie gedacht oder sogar ganz ausfällt.","20-24":"Auf dieser Party oder größeren Veranstaltung wirst du auf jemanden oder etwas treffen, an das du dein Herz verlieren könntest.","20-25":"Hier geht es um eine Hochzeit oder um eine Veranstaltung von ähnlicher Bedeutung für dich. Vielleicht ist es der Grundstein für eine neue, bessere gesellschaftliche oder politische Stellung. Du bekommst vielleicht bald einen Heiratsantrag.","20-26":"Vielleicht ist es Zeit für eine Weiterbildung, ein Seminar in einem Bereich, der für deine persönliche Entwicklung wichtig ist oder der Einstieg in ein Studium, dass du dir schon lange gewünscht hast.","20-27":"Du bekommst eine Einladung zu einer Veranstaltung oder eine Party. Vielleicht handelt es sich auch um einen positiv bewilligten Bescheid für eine Reha oder eine Kur, die du jetzt antreten kannst.","20-28":"Als Person: Dieser Herr steht in der Öffentlichkeit. Vielleicht ist er auch in einem Hotel angestellt, in einer Kurklinik oder einem Krankenhaus. Als Situation: Hier wirst du aufgefordert, um aktiv zu werden. Du wirst an einem öffentlichen Ort, einer Bücherei vielleicht oder in einem Café oder Restaurant fündig.","20-29":"Als Person: Diese Dame steht in der Öffentlichkeit. Vielleicht ist sie auch in einem Hotel angestellt, in einer Kurklinik oder einem Krankenhaus. Als Situation: Um neue Menschen kennen zu lernen ist es manchmal sinnvoll, Orte zu besuchen, an denen Menschen zu finden sind. Vielleicht kannst du dich zu einem Kurs an der Volkshochschule anmelden oder eine Selbsthilfegruppe besuchen. Dort trifft man auf Gleichgesinnte und kann sich vom richtigen Herzen finden lassen.","20-30":"Um die Leidenschaft für jemanden oder etwas neu zu entfachen, kann es manchmal notwendig sein, etwas ganz verrücktest zu tun. Da gibt es Möglichkeiten, die Lust zu stimulieren. Und wenn wir bedenken, dass die Lilie zusammen mit dem Park ein Bordell bezeichnen könnte, wirst du von deinem Universum mit einem Augenzwinkern dazu aufgefordert, kreativ zu sein.","20-31":"Dein Glück spricht sich schnell herum. Vielleicht möchtest du auf etwas, dass du selbst gebastelt oder angefertigt hast, aufmerksam machen. Soziale Netzwerke bieten da ein bezauberndes Medium.","20-32":"Wenn es dein Wunsch ist, mit deinem Talent berühmt zu werden, dann gibt es nur noch eines, was du unbedingt machen musst: Tu es! Jeden Tag, mehr und mehr und so kommst du deinem Ziel jeden Tag ein kleinen Schritt näher. “Harry Potter” ist auch nicht über Nacht geschrieben worden. Du hast es schon in dir. Starte jetzt!","20-33":"Der Schlüssel für die Lösung deiner Aufgabe liegt dort, wo viele Menschen sind. Du musst dich unter Menschen begeben, von deinen Talenten erzählen und auf dich aufmerksam machen, dann wirst du mit Sicherheit erfolgreich sein.","20-34":"Was immer du dir von anderen Menschen wünscht oder erhoffst, verteile es. Das, was du anderen geben kannst, wirst du selbst tausendfach zurück erhalten. Liebe, wenn du nach Liebe suchst und helfe aus, wenn du Hilfe brauchst.","20-35":"Du wirst dort tätig werden, wo du mit vielen Menschen zu tun hast. Wenn du eine neue Arbeit suchst, kann es sogar auf einem Flughafen sein. Wenn du deiner Berufung folgen möchtest, so wird auch das vielen Menschen zum Wohle gereichen.","20-36":"Dies ist eine wichtige Veranstaltung und sie wird dir schwer auf deinen Schultern lasten und letztlich wirst du froh sein, sie überstanden zu haben. Sie ist für dein persönliches Wachstum wichtig. Du kommst nicht daran vorbei.","21-22":"Du befindest dich am Ende eines Weges. Auch wenn du es dir selbst noch nicht eingestehen möchtest, es handelt sich um eine Sackgasse und wenn du es weiterhin versuchst, verschwendest du nur deine Zeit.","21-23":"Dies ist deine Stunde: Alle Hindernisse heben sich nach und nach wie von Zauberhand auf. Das Glück ist auf deiner Seite.","21-24":"Du hast dein Herz hinter einer großen Mauer eingesperrt. Sicher, es sollte zu deinem Schutze sein, vor neuen Verletzungen und neuem Leid. Und so kann es passieren, dass auch die schönen Gefühle nicht mehr bis zu deinem Herzen durchdringen.","21-25":"Diese Verbindung (gesellschaftlich, geschäftlich oder privat) wird auf eine harte Belastungsprobe gestellt und es wird eine arge Herausforderung, sich an die vertraglichen Bedingungen zu halten.","21-26":"Kennst du auch dieses Gefühl, zu lernen und zu lernen und dennoch zu erkennen, wie wenig man über das Thema weiß oder wie weit man noch zu gehen hat? Halte durch, dann geht das Gefühl vorbei, es lohnt sich.","21-27":"Vielleicht wartest du schon sehnsüchtig auf eine Nachricht oder eine wichtige Information in einer Angelegenheit. Dieses Warten wird zu einer wahren Zerreißprobe.","21-28":"Als Person: Dieser Herr hat in seinem Leben mit vielen Hindernissen zu kämpfen und das macht ihn auch zu einer starken und abgehärteten Persönlichkeit. Als Situation: Was du auch unternimmst, es wird nicht die Ergebnisse erzielen, die du dir erhofft hast.","21-29":"Als Person: Diese Dame ist in ihrem Leben schon schwer vom Schicksal belastet worden. Sie könnte deine ritterliche Unterstützung brauchen. Als Situation: Abwarten und Tee trinken ist in diesem Moment das Beste, was du tun kannst. Alles andere führt einfach zu nichts.","21-30":"Vor das Vergnügen hat der Herr die Arbeit gestellt, aber was du dir zumutest, ist zu viel des Guten und so hast du dich, bewusst oder unbewusst, selbst von deiner Lebensfreude fortbewegt.","21-31":"Bessere Zeiten sind in Sicht, auch wenn es noch eine Weile dauern könnte, bis es so weit ist, kannst du die ersten herrlich warmen Sonnenstrahlen schon genießen.","21-32":"Sicher hast du auch das Recht, in schlechter Stimmung zu sein und auch noch eine Weile zu bleiben. Das trägt aber wenig zur Veränderung der Situation bei.","21-33":"Jetzt geht es voran und die Hindernisse und Schwierigkeiten werden dir fast wie von allein aus dem Weg geräumt. Du kannst aufatmen.","21-34":"Wenn du momentan mit vielen kleineren und größeren Schwierigkeiten zu kämpfen hast, so wird es sich auch noch eine Weile so fortsetzen. Die Schwierigkeiten vermehren sich.","21-35":"Harte Arbeit liegt vor dir und es geht immer nur Berg auf, und es wird dir sicher nicht leicht gelingen, dein Ziel zu erreichen. Mach dir einen genauen Plan, an den du dich halten kannst, dann geht es leichter.","21-36":"Du hast es geschafft und bist “über den Berg”. Hindernisse sind überwunden und Schwierigkeiten sind aus dem Weg geschafft. Herzlichen Glückwunsch.","22-23":"Du kommst jetzt schneller an dein Ziel, als du es dir vorstellen konntest. Wege werden abgekürzt und Entscheidungen werden schnell und souverän getroffen.","22-24":"Es ist die richtige Entscheidung, die du getroffen hast, weil du mit dem Herzen dabei bist. Auch wenn dein Verstand vielleicht etwas zu mosern findet und dich mahnt: “Jetzt werde doch vernünftig!” Du bist auf dem richtigen Weg.","22-25":"Zwei Verträge zu ein und derselben Angelegenheit kann ja das Sicherheitsbedürfnis arg beruhigen, allerdings ist es nicht immer sinnvoll zweigleisig zu fahren, auch wenn die Angelegenheit von höchster Priorität ist.","22-26":"Es gibt verschiedene Wege, um ans Ziel zu gelangen. Einer davon ist lernen. Es geht um wichtige Dokumente, die dich in dieser Situation ein entscheidendes Stück voran bringt.","22-27":"Diese Neuigkeiten werden auf eine besondere Art noch von entscheidender Bedeutung für dich sein. Aufgrund dieser Nachrichten kannst du eine sichere Entscheidung treffen.","22-28":"Als Person: Dieser Herr macht einen äußerst entschlossenen Eindruck. Als Situation: Du hast dir eine bestimmte Strategie zurecht gelegt, jetzt ist es an der Zeit, sie entschlossen durchzusetzen.","22-29":"Als Person: Diese Dame macht einen äußerst entschlossenen Eindruck. Als Situation: Selbst wenn die Dinge umständlich werden, musst du konsequent bleiben!","22-30":"Eine leidenschaftliche Bekanntschaft kann eine erfrischende Alternative bieten. Nur wird es auf lange Sicht nicht das, was du dir erhoffst.","22-31":"Du hast, bewusst oder unbewusst, ein glückliches Händchen bei deiner Entscheidung, nun kannst du leicht und beschwingt deinem neuen Weg folgen.","22-32":"Ob eine Situation positiv oder eher belastend ist, entscheidest du aus deinen Erfahrungen heraus und mit Hilfe deiner Bewertung. Sicher ist es möglich und sinnvoll, nicht immer alles zu mögen. Aber in dieser Situation kannst du dich ganz alleine für den ruhmreichen Weg entscheiden.","22-33":"Vielleicht bist du noch unsicher, nur weil du vertraute Pfade verlassen hast, um deinen Weg zu gehen. Hier ist deine Antwort: Es ist mit absoluter Sicherheit die richtige Entscheidung gewesen!","22-34":"Wenn du gerade versuchst, eine sinnvolle Entscheidung zu treffen und dir die Argumente Pro und Kontra vor Augen führst, findest du immer mehr Pro´s und Kontra´s… das stiftet nur Verwirrung. Lass dein Herz entscheiden.","22-35":"Etwas oder jemand hindert dich daran, eine sinnvolle Entscheidung zu treffen. Nicht weil er es nicht gut mit dir meint, sondern eher im Gegenteil, weil er (oder es) so sehr an dir hängt.","22-36":"Es gibt einen alten Brauch, in dem man an Halloween an einer Weggabelung eine Opfergabe für die „Gute Göttin“ Hekate hinterlässt, damit sie uns nicht in die Irre führt und uns bei guten Entscheidungen hilfreich zur Seite steht. Du kannst auch zu jeder anderen Zeit im Jahr auf diese oder ähnliche Weise ein Opfer erbringen, um deine Entscheidungen zu segnen.","23-24":"Das was du wirklich liebst, lass frei. Kommt es zu dir zurück, liebt es dich für immer. Bleibt es fort, hat es dich nie geliebt. Du machst dir einfach zu viele Gedanken darum, was dazu führt, das jemand oder etwas von dir weg will.","23-25":"Diese Beziehung hat ihren Dienst getan. Auch wenn du es vielleicht noch nicht einsehen möchtest, lass den Dingen ihren Lauf.","23-26":"Sorge dafür, dass du bestmöglich vorbereitet bist, das gibt dir Sicherheit. Wenn du dich aufregst, sorgt das Adrenalin in deinem Blut dafür, dass du nicht einmal die Antworten weißt, die du wissen könntest. Ein Geheimnis wird gelüftet. Danach wird sich einiges ändern.","23-27":"Du wartest vielleicht darauf, von jemandem angerufen oder angeschrieben zu werden, über das Internet vielleicht (E- Mail, Chat- oder Privatnachricht). Diese Nachrichten gehen verloren und deine Erwartungen werden nicht erfüllt.","23-28":"Als Person: Dieser Herr hat Kummer und macht einen kränklichen Eindruck. Als Situation: Vielleicht machst du dir Sorgen, wie du bestmöglich durch diese Situation hindurch gelangen kannst oder es bereitet dir Kummer, einfach nur zusehen zu müssen und nicht wirklich eingreifen zu können.","23-29":"Als Person: Diese Dame macht sich immer viele Sorgen, keine Angst, sie meint es nur gut. Als Situation: Du musst abwarten, wie sich die Dinge entwickeln, du kannst momentan nicht viel daran ändern, auch wenn es dir Kummer bereitet oder Sorgen macht.","23-30":"Eine Beziehung zu jemand oder etwas verläuft sich nicht in die harmonischen Bahnen, die du dir erhofft hast. Letztlich wirst du die Verbindung doch auflösen.","23-31":"In deiner Nähe tummeln sich Energieräuber. Vielleicht hast du nie gelernt, auch mal Nein zu sagen und versuchst es immer allen recht zu machen. Das lockt diese Schmarotzer an und lässt es ihnen gut gehen. Alleine dein Energielevel wird immer niedriger dadurch.","23-32":"Was du dir auch vornimmst, momentan wird es dir nicht gelingen. Du suchst nach Möglichkeiten, vielleicht schon obsessiv und so findest du nur Dinge oder Personen, die dich noch mehr suchen lassen. Das was du suchst, hast du schon in dir.","23-33":"Im Erreichen deines Ziels gibt es noch den ein oder anderen Unsicherheitsfaktor. Prüfe das nach, damit die Sache nicht schief geht.","23-34":"Je mehr du versuchst, etwas oder jemanden zu erreichen, um so mehr wird es sich deiner Absicht entziehen wollen. Denke immer daran: Du kannst niemanden zwingen, mit dir zusammen sein zu wollen, du kannst dich nur entsprechend interessant machen.","23-35":"Resignation ist nicht die Lösung für deine momentane Situation. Überlege genau, was du tun kannst, dann starte noch einmal neu. Lass dich nicht entmutigen.","23-36":"Schon wieder scheinst du alles verloren zu haben, was dir etwas bedeutet. Zum wievielten Mal jetzt? Anstatt dich zu fragen: Warum immer ich? Könntest du so Dinge fragen, wie: Was soll ich daraus lernen? Vielleicht, dass du dein Herz nicht zu arg an irdische Dinge hängen sollst. Vielleicht auch nicht an eine irdische Liebe. Alles, was du brauchst ist bereits in dir. Und wenn du selbst nicht in der Lage bist, es dir zu geben, wirst du es auch nicht von jemand anderem erhalten.","24-25":"Dies ist eine Verbindung, wobei die Vertragspartner mit vollem Herzen beteiligt sind. Du kannst deiner Sache heute und auf lange Sicht sicher sein.","24-26":"Es ist dir zu Raten, von deiner Liebe und Zuneigung zu jemandem oder etwas nicht all zu viel Aufhebens zu machen. Es könnten Kräfte wie Neid und Missgunst deinem Ziel entgegenwirken wollen, wenn sie davon wüssten.","24-27":"Du bekommst Nachrichten, die dein Herz erfreuen. Das macht dich glücklich und bringt dir frische, neue Energie, so dass dir alles leicht zu fallen scheint.","24-28":"Als Person: Dieser Herr ist sehr herzlich, charmant und fröhlich. Es macht Spaß, in seiner Nähe zu sein und du fühlst dich verliebt. Als Situation: Du schwebst auf Wolke 7 und nichts ist dir zu schwierig oder zu anstrengend, um aktiv deine Ziele zu verfolgen.","24-29":"Als Person: Diese Dame ist eine sehr herzliche und liebevolle Frau. Sie ist fürsorglich und von Herzen schön. Als Situation: Du hast die seltene Gabe in deinem Herzen, auch in den schwierigsten Situationen noch das Schöne und Passende zu erkennen. Jetzt wirst du von dieser Gabe profitieren.","24-30":"Hier fallen Liebe und Leidenschaft für jemanden oder etwas zusammen und das ist eine Kombination die sich gegenseitig verstärkt und zu immer neuen, wundervollen Energien aufschwingt.","24-31":"Wenn du nicht schon von innen heraus strahlst, so wirst du es bald tun. Du hast (wieder) die Sonne im Herzen und steckst alle mit deiner Fröhlichkeit an. Eine echte Bereicherung.","24-32":"Dies ist eine sehr romantische Liebesgeschichte. Auch wenn es nicht immer um die Beziehung zwischen zwei Personen geht, so kann es sich doch auch um eine romantische Leidenschaft handeln.","24-33":"Jemand oder etwas hat den Schlüssel zu deinem Herzen gefunden. Dabei kann es sich ebenso um eine alte Liebe handeln, die wieder neu entfacht wird, oder um eine vollkommen Neue (zu jemandem oder etwas…).","24-34":"Womit wir uns tagein, tagaus beschäftigen in unserem Leben, das wird mehr. Glücklicherweise bist oder kommst du in eine Situation in der du dich viel mit der Liebe zu etwas oder jemandem beschäftigst, auch das wird mehr und das ist wundervoll.","24-35":"Diese Liebe ist nicht auf Sand gebaut, ganz im Gegenteil! Es handelt sich hier um eine grundsolide Liebe zu jemandem oder etwas, die sehr lange Bestand haben wird.","24-36":"Manchmal verwechseln wir unsere irdische Liebe mit der wahren, bedingungslosen Liebe unseres Universums. Das können wir an so Liedtexten erkennen, wie: “Love hurts…” oder “Love is a battlefield…” Denke immer daran: Wenn es weh tut, ist es keine Liebe, dann ist es irgendetwas anderes und muss anders bezeichnet werden. Aber Liebe ist wundervoll, bedingungslos und groß!","25-26":"In dieser Beziehung wird etwas verheimlicht. Diese Partnerschaft wird mit wichtigen Dokumenten untermauert. Es wird also ernst, wenn die Papiere unterschrieben sind. In seltenen Fällen kann es sich auch um eine heimliche Verbindung, vielleicht sogar um einen Geheimbund handeln, ein Konvent oder einen magischen Zirkel.","25-27":"Die Vertragsunterlagen kommen zu deiner Ansicht ins Haus. Denke immer daran: Drum prüfe, wer sich ewig bindet… Jetzt hast du noch Gelegenheit dazu.","25-28":"Als Person: Dieser Herr ist an jemanden oder etwas sehr stark gebunden. Es kann möglich sein, dass das in seiner Beziehung zu dir Konsequenzen hat. Als Situation: Du kannst selbst bestimmen, wie weit du dich in diese Angelegenheit einbinden lässt.","25-29":"Als Person: Diese Dame ist an jemanden oder etwas sehr stark gebunden. Es ist möglich, dass das in seiner Beziehung zu dir Konsequenzen hat. Als Situation: Vielleicht versuchst du gerade einen Ausweg aus dieser Angelegenheit zu finden, nur um festzustellen, dass du dich immer und immer wieder im Kreise drehst. Du solltest dich fragen: Wie genau kannst du lernen, was immer du lernen solltest.","25-30":"Hier geht es um eine leidenschaftliche und harmonische Beziehung zu jemanden oder etwas, vielleicht sogar im familiären Kreis. Wenn es sich um eine Affäre handelt, so wird es diesen Status auch nicht überschreiten, da die Verbindung zu dem anderen Partner auf einer gewissen Ebene sehr stark ist.","25-31":"Dies ist eine besonders glückliche Verbindung. Du hast alles richtig gemacht, denn dieser Vertragsabschluss (im weitesten Wortsinne) gereicht zum höchsten Wohle aller.","25-32":"Dies ist eine tiefe Verbindung auf Seelenebene, die weit über das Vertragliche hinaus geht. Nutze die Energie, die aus dieser Anziehungskraft entspringt.","25-33":"Dieser Vertrag, diese Verbindung ist der Beginn von etwas Größerem, das Erfolg verspricht und gutes Gelingen. Dies ist “just the beginning…” (erst der Anfang).","25-34":"Man sagt, der goldene Ring ist das kleinste und komfortabelste Gefängnis der Welt. Wie immer auch deine Einstellung zu dieser Verbindung ist, es wird sich auf genau diese Art noch verstärken.","25-35":"Diese Verbindung beruht auf Gegenseitigkeit. Es ist ein Gewinn für beide Seiten zu erwarten, eben eine Win- win- Situation. Manchmal ist auch ein neuer Arbeitsvertrag oder eine Beförderung gemeint.","25-36":"Diese Beziehung ist wichtig um zu erkennen, auf welche Weise du Beziehungen eingehst. Wenn diese Prüfung bestanden ist, kannst du neue Erfahrungen machen.","26-27":"Diese Nachricht ist nicht für die Augen und Ohren der breiten Masse bestimmt, vielleicht nicht einmal für deine. Es könnte sich auch um das Tagebuch einer anderen Person handeln, in dem du gerne lesen möchtest?","26-28":"Als Person: Dieser Herr ist noch völlig unbekannt. Wenn das Buch zwischen euch liegt, so kann es möglich sein, dass er etwas zu verbergen hat, oder dass du in einer Angelegenheit nicht so genau hinschauen magst, um die Wahrheit zu erkennen. Als Situation: Du versuchst mehr von allen Aspekten einer Situation zu erfassen und heraus zu bekommen und das ist genau der richtige Weg.","26-29":"Als Person: Diese Dame ist eine sehr kluge Frau. Es kann sein, dass sie noch völlig unbekannt ist oder eben so verschlossen, dass sie auch immer auf eine Weise unbekannt bleiben wird. Als Situation: Du brauchst dich nicht bemühen, ein bestimmtes Geheimnis zu lüften, das wäre vergeudete Energie. Wenn es an der Zeit ist, wirst du es doch erfahren.","26-30":"Das könnte eine prickelnde und leidenschaftliche Affäre werden, da es sich vom Reiz des Unbekannten nährt. Ein intelligenter (und vielleicht sogar aufregender) Mann wird sich um dich bemühen und dich als dein Förderer in dieser Angelegenheit unterstützen.","26-31":"Wenn du dich beim Lernen oder in einem Studium schwer getan hast, so kommen nun sonnigere Zeiten. Du kannst wieder aufatmen und neue, frische Energie tanken, vielleicht sogar aus dem, was du bisher gelernt hast.","26-32":"Hier geht es nicht nur um die Aneignung von neuen Erkenntnissen, sondern um eine Seelenerfahrung, in der dir tiefes Wissen zuteil wird, das einer wundervollen Offenbarung gleich kommt.","26-33":"Ein Geheimnis wird gelüftet, was dir einige Türen öffnet und zu mehr Erfolg verhilft. Wenn du mit dem Gedanken spielst, ein Buch zu schreiben, so solltest du jetzt damit anfangen. Das Universum wird dir hierbei hilfreich zur Seite stehen. Solltest du diese Idee noch nicht gehabt haben, dann überlege doch mal, welches Talent du hast, das viele Menschen interessieren und ganz sicher auch weiter helfen kann.","26-34":"Hier kommen schöne Dinge auf dich zu, von denen du jetzt noch nichts weißt. Vielleicht ist es eine Überraschungsparty? Vielleicht sollst du mal so richtig verwöhnt werden. In jedem Fall hast du es dir redlich verdient.","26-35":"Wenn du schon immer gerne geschrieben hast, Geschichten vielleicht oder Gedichte, vielleicht aber auch Blogartikel, dann hast du jetzt die Möglichkeit, aus deiner Berufung einen Beruf zu machen; mit Erfolg.","26-36":"Manchmal sind Bücher mehr als eine Ansammlung von Worten, manchmal haben sie die Macht und die Kraft, in einer bestimmten Weise auf unser Schicksal Einfluss zu nehmen. Wenn Schreiben dein Handwerk ist, so ist die Schriftstellerei dein Schicksal. Vielleicht denkst du noch, es ist nicht gut genug, was du schreibst, vielleicht sind es auch die Konventionen, die dich davon abgehalten haben. Lass dir jetzt Flügel wachsen und schwing dich auf, das ist deine Zeit!","27-28":"Als Person: Dieser Herr (ist Postbote) hat mit dem Überbringen von Nachrichten zu tun. Vielleicht bekommst du auch das Eintreffen einer Nachricht mit (inklusive Inhalt) die eigentlich für ihn bestimmt ist. Als Situation: Wenn du dringend auf eine Nachricht wartest, solltest du dich jetzt auf den Weg machen, um ihr (wie auch immer) entgegenzugehen.","27-29":"Als Person: Diese Dame hat mit der Übermittlung von Nachrichten zu tun und redet daher vielleicht auch gerne und viel. Fast könnte man sagen, dass man eine Nachricht nur im Vertrauen an sie richten muss, wenn es das ganze Dorf erfahren soll. Als Situation: Du kannst die Nachricht, auf die du so sehnlichst wartest, nicht dadurch schneller erhalten, indem du ungeduldig bist und quengelnt hin und her läufst. Du kannst nichts weiter tun, als Geduld zu üben.","27-30":"Diese Nachricht bringt dich wieder in deine Mitte und vor allem zeigt sie auch an, wo mit Unterstützung für dein Vorhaben zu rechnen ist. Es kann eine aufregende Vorstellung sein, auf der Kautsch neben dem Ehemann zu sitzen und eine SMS vom Liebsten zu erhalten. Aus Fairness sollte es bei der Vorstellung bleiben und sich überlegt werden, wie man diese Leidenschaft in seiner aktuellen Beziehung neu entfachen kann.","27-31":"Dies ist genau die erlösende Nachricht, auf die du gewartet hast. Fürs erste sind die Wogen geglättet, die Sonne geht wieder auf und eine neue Runde beginnt.","27-32":"Dies ist eine Nachricht, die dich in der Seele berührt und glücklich macht. Vielleicht ist es ein Dankesschreiben von einem Menschen, dem du vor nicht all zu langer Zeit geholfen hast, vielleicht ein Liebesbrief, der dir zeigt, was du für ein wertvoller Mensch bist.","27-33":"Die erhoffte Nachricht ist jetzt so gut wie da und sie hat mit an Sicherheit grenzender Wahrscheinlichkeit genau auch den erhofften Inhalt.","27-34":"Wenn es sich nicht direkt um eine Geldüberweisung handelt, dann ist es eine Nachricht, die das Grundthema deiner Situation unterstreicht.","27-35":"Beim Eintreffen dieser Nachricht kann es passieren, dass du mit den Augen rollst und dir wünscht, sie nicht erhalten zu haben. Es kann sein, dass sie von jemandem kommt, der arg an dir hängt. Vielleicht solltest du aufhören, auf Nachricht zu hoffen. Wenn du schon mehr als eine Woche wartest, kann ich dir aus Erfahrung sagen, dass du nichts weiter hören wirst. Außer es handelt sich um eine Buße wegen zu schnellem Fahren, die kommt noch nach einem Jahr… Manchmal kann hier auch die Einladung zu einem Vorstellungsgespräch gemeint sein, wenn man darauf wartet.","27-36":"Diese Nachricht hat es in sich! Sie ist zwar in den meisten Fällen positiv, wird aber dennoch oft als sehr intensiv erfahren.","28-29":"In diesem Falle handelt es sich um die Seelenpartner in unserem Spiel. Dieser Herr und diese Dame haben auf einer anderen Ebene eine Vereinbarung getroffen und begegnen sich nun, um gemeinsame Erfahrungen zu machen.","28-30":"Als Person: Dieser Herr ist ein Frauentyp. Wenn du dich auf ihn einlässt oder schon eingelassen hast, solltest du das bedenken. Es kann aber auch möglich sein, dass er sich nur heimlich wünscht, ein Frauentyp zu sein, und um es auch wirklich, wirklich zu erreichen, tut er alles und ist dabei sehr harmoniesüchtig. Als Situation: Du solltest all deine Gedanken zusammen nehmen und rational an die Dinge heran gehen. Stelle dir konstruktive Fragen!","28-31":"Als Person: Dieser Herr hat ein sonniges Gemüt und ist immer sehr optimistisch. Es ist eine fröhliche Zeit, mit ihm zusammen zu sein. Als Situation: Wenn du dir zu viele Gedanken machst, stehst du dir nur selbst im Wege. Du kannst frohen Mutes sein, und wenn du jetzt danach Ausschau hältst, findest du auch die Gründe für diesen Optimismus.","28-32":"Als Person: Dieser Herr ist sehr sensibel und gefühlvoll. Es kann allerdings auch möglich sein, dass seine Gedanken mit unter sehr tiefgründig werden können und emotional. Als Situation: Du musst sensibel mit der Situation und den daran Beteiligten umgehen damit du an dein Ziel gelangst.","28-33":"Als Person: Dieser Mann ist sehr gewissenhaft und zuverlässig; und durch seine Gewissenhaftigkeit ist er auch erfolgreich. Als Situation: Du musst dir einen genauen Plan machen und dich gewissenhaft daran halten, um dein Ziel zu erreichen.","28-34":"Als Person: Dieser Herr ist eher materialistisch eingestellt und Äußerlichkeiten bedeuten ihm viel. Als Situation: Die Dinge und Angelegenheiten haben außer ihrem festen Bezug in der materiellen Welt auch immer noch eine geistige Ebene, eine Ebene der Gefühle und was wir den Dingen für eine Bedeutung beimessen. Das solltest du beachten, wenn du etwas erreichen willst.","28-35":"Als Person: Dieser Herr ist sehr fleißig; zumindest strengt er sich immer arg an. Und es ist durchaus möglich, dass er eher von der anhänglichen Art ist. Als Situation: Du musst dich mehr anstrengen und fleißiger sein, sonst nimmt dir jemand anderes deinen Erfolg!","28-36":"Als Person: Dieser Herr ist sehr an der geistigen Welt und an Geisteswissenschaften interessiert. Vielleicht hat er ein Psychologiestudium absolviert, eine NLP- Ausbildung oder er interessiert sich vielleicht sogar für Astrologie, für Glauben und Religion. Als Situation: An dieser Stelle konkurrieren Glaube und Ratio; Herz und Verstand. Du solltest dich nicht für eines entscheiden, sondern das Beste von beidem nutzen.","29-30":"Als Person: Diese Dame ist sehr harmoniebedürftig, aber auch sehr leidenschaftlich. Daher ist es möglich, dass sie um des lieben Frieden Willens nicht immer direkt sagt, was ihr nicht passt, dann aber gelegentlich explodiert, um ihre Gefühle zu kompensieren. Als Situation: Momentan bewegst du dich auf einem Mienenfeld. Vielleicht ist es sinnvoller, gute Miene zum bösen Spiel zu machen und zu überlegen, welche Möglichkeiten dir außerdem noch zur Verfügung stehen.","29-31":"Als Person: Diese Dame ist sehr optimistisch, ein wahrer Sonnenschein. Du hast mit ihr nicht nur einen Seelenverwandten an der Seite, sondern auch einen wahren Freund und Kumpel. Als Situation: Du kannst optimistisch an die Sache herangehen, mit dem, was man weibliche Intuition nennt, hast du schon ein genaues Gespür für das, was als nächstes kommt.","29-32":"Als Person: Diese Dame ist sehr sensibel und gefühlvoll. Es ist sogar möglich, dass man in ihrer Gegenwart etwas auf seine Wortwahl achten sollte. Als Situation: Nicht immer gibt es ein Geheimnis, hinter einem Geheimnis, hinter einem Geheimnis! Auch wenn du den Dingen gerne auf den Grund gehst, bist du an dieser Stelle gut beraten, wenn du es auf sich beruhen lässt und abwartest, was als dir als nächstes auf deinen Weg gelegt wird.","29-33":"Als Person: Diese Dame ist sehr zuverlässig und gewissenhaft. Du kannst dich auf sie verlassen. Als Situation: Auch wenn es dir momentan vielleicht nicht schnell genug geht und die Dinge länger brauchen als erwartet, um sich zu entwickeln, kannst du doch nichts weiter tun als abwarten, aber mit der Gewissheit, dass sich alles zu deinem Wohle richtet.","29-34":"Als Person: Diese Dame ist eher materiell eingestellt und auf Äußerlichkeiten legt sie besonderen Wert. Als Situation: Nicht immer ist alles so, wie es sich im Augenblick darstellt. Versuche einen Blick hinter die Kulissen und erahne das ganze Bild.","29-35":"Als Person: Diese Dame ist sehr fleißig und kümmert sich immer gerne um alles und um die Aufgaben, die ihr aufgetragen werden. Manche sagen, dass sie von Natur aus eher anhänglich ist. Als Situation: Du wirst nicht eher weiter gehen können, bevor du nicht alle Aspekte dieser Situation betrachtet und verstanden haben wirst. Das erfordert noch etwas Arbeit, aber du bist schon ein gutes Stück weiter gekommen.","29-36":"Als Person: Diese Dame ist sehr spirituell, mysteriös und geheimnisvoll. Das macht ihre starke Anziehungskraft aus. Auch wenn du dich noch dagegen sträubst, du wirst ihrem Charisma erliegen, so oder so… Als Situation: In dieser Angelegenheit solltest du dich auf die Macht und Kraft deiner Weiblichkeit verlassen. Das ist deine große Stärke in dieser Situation.","30-31":"Als Person: Diese Dame ist sehr optimistisch, ein wahrer Sonnenschein. Du hast mit ihr nicht nur einen Seelenverwandten an der Seite, sondern auch einen wahren Freund und Kumpel. Als Situation: Du kannst optimistisch an die Sache herangehen, mit dem, was man weibliche Intuition nennt, hast du schon ein genaues Gespür für das, was als nächstes kommt.","30-32":"Dies ist eine Leidenschaft, die das Potential hat, dich tief in deiner Seele zu berühren und vielleicht sogar deine Welt für einen Moment auf den Kopf zu stellen.","30-33":"Hilfe ist schon unterwegs zu dir. Vielleicht kommst du in dieser Situation nicht weiter oder benötigst einen wichtigen Rat. Du erhältst Unterstützung von einer Person, für die du überaus wichtig bist.","30-34":"Jetzt ist es so weit. Du hast die notwendige Leidenschaft für etwas oder jemanden in dir erwecken können und plötzlich, so scheint es, funktionieren die Dinge fast wie von allein.","30-35":"Liebe und Hingabe an den Beruf oder die Berufung macht aus dem, was man seinen “täglichen Job” nennt, ein Fest.","30-36":"Leidenschaft für seine Aufgabe zu entwickeln ist wie das Salz in der Suppe: Es geht vielleicht ohne, nur schmeckt es dann nur halb so gut. Man mag der Meinung sein zu sagen: “Sex ist nicht alles…” Aber du kannst dir gewiss sein: Ohne Sex ist alles nichts.","31-32":"Du hast es geschafft, bewusst oder unbewusst, zwei komplett gegensätzliche Aspekte einer Sache oder einer Situation zu verbinden. Jetzt warten Dank und Anerkennung auf dich.","31-33":"Du bist soeben auf die Zielgerade eingebogen. Vielleicht hast du viel Mühe und Zeit in dein Projekt investiert und jetzt weißt du, dass du dein Ziel erreichst, du brauchst einfach nur noch gerade aus weiter zu laufen, nichts und niemand kann dich mehr aufhalten!","31-34":"Wo die Sonne hin scheint, rührt sich neues Leben. Nutze diese Phase, um auch alte und vielleicht verstaubte Dachkammern mit frischem, neuen Licht durchfluten zu lassen.","31-35":"In dieser Situation arbeitet das Glück für dich und du darfst dich freuen, auf das, was dir vom Universum gebracht wird.","31-36":"Wenn du gerade eine schwierige Phase überstanden hast, kommt jetzt das Glück und viel frische, neue Energie zu dir zurück. Wenn nicht, dann wird es bald soweit sein.","32-33":"Du hast ein besonderes Talent, anderen Menschen in die Seele zu schauen. Dieses Talent solltest du zum Wohle anderer einsetzen. In dieser Angelegenheit ist dir der Erfolg gewiss und du wirst reichlich Anerkennung ernten, wenn es darum geht, ein Ziel zu erreichen.","32-34":"Du hast einen Weg gefunden, wie du dir selbst die Ehre und Wertschätzung zu Teil werden lässt, die du dir schon immer so sehnlich gewünscht hast. Wenn nicht, dann sollte das dein Ziel sein, denn worauf man seine Aufmerksamkeit richtet im Leben, vermehrt sich.","32-35":"Die Gedanken, die dir in Bezug auf diese Situation durch den Kopf gehen, bringen dich nicht weiter und es erschöpft dich, wenn es in deinem Kopf denkt, wie auf einer Langspielplatte. Frag deine Seele um Rat und Hilfe, sie weiß, was zu tun ist. Vielleicht bist du ein Nachtmensch, und kannst dir die Antwort auf deine Frage am besten in der Nacht erarbeiten. Vielleicht leidest du aber auch unter Schlafschwierigkeiten, weil dir deine Arbeit nicht aus dem Kopf gehen mag, da kann Baldriantee eine Möglichkeit sein.","32-36":"In dieser Situation kann ein Aspekt deiner Lernaufgabe sein, Geschenke auch anzunehmen. Das beginnt bei Komplimenten und dem sind nach oben natürlich keine Grenzen gesetzt. Überlege einmal, welch Freude du anderen damit machst, wenn du dich von ehrlichem Herzen über die Liebe und Anerkennung freust, die dir zu Teil werden. Das ist ja der Grund, warum wir gerne etwas verschenken.","33-34":"Dieser Erfolg, es kann auch die Erreichung eines Teilzieles sein, setzt eine Kette von weiteren Erfolgen in Gang, da es auch darum geht, die Freude und den Spaß am Leben zu genießen. Du erlebst wieder mehr Sicherheit im Leben, wenn sie dir verloren ging. Damit kann auch deine Selbstsicherheit gemeint sein.","33-35":"Wenn du heute einem Schornsteinfeger begegnest, solltest du ihn küssen! Oder zumindest herzlich umarmen und sich an seiner Gegenwart erfreuen. Er ist ein wichtiger Hinweis auf bevorstehendes Glück und Erfolg in deinen Angelegenheiten. Du wirst dein Ziel erreichen und dich durchsetzen können.","33-36":"Es ging darum, zu lernen, dass du der einzige Mensch bist, auf den du dich wirklich verlassen kannst. Niemandem sonst kannst du in den Kopf schauen, oder ins Herz. Jedenfalls nie mit absoluter Sicherheit.","34-35":"Wenn wir manchmal die Dinge zu wichtig nehmen, machen wir uns damit mehr Arbeit, als notwendig ist. Schau, ob du die Dinge nicht leichter bewerkstelligen kannst.","34-36":"Druck erzeugt immer einen Gegendruck. Und mehr Druck erzeugt mehr Gegendruck. Gib es auf, gegen das Universum kannst du nicht gewinnen.","35-36":"Du wirst immer hart für die Erreichung deiner Ziele arbeiten müssen. Jedenfalls so lange, wie du glaubst, dass es so ist."};
const PERSON_MATRIX={"1":{"sternzeichen":"Widder, Löwe, Schütze","haarfarbe":"weiß, hell, blond","charakter":"sportlich, sehr aktiv","figur":"schlank","signifikator":"Ein junger Mann, mehr seinen Aufgaben verpflichtet, als großen Worten; sehr ritterlich.","beruf":"Berufe die mit Nachrichtenübermittlung und Transport zu tun haben, Funker, Postbote, Vermittlungstechniker, Endstellenbauer, LKW-Fahrer, Pferdewirt","groesse":"groß","alter":"gleich alt, jünger","woher":"eine zufällige Begegnung, bei einem (Blind) Date, unterwegs zu jemandem oder etwas"},"2":{"sternzeichen":"Zwilling, Waage, Wassermann","haarfarbe":"hell, blond","charakter":"unbekümmert, gut drauf, positiv denkend","figur":"normal","signifikator":"Dieser Mensch ist ein unverbesserlicher Optimist, etwas oberflächlich vielleicht, aber sehr bezaubernd.","beruf":"Berufe mit Pflanzen: Gärtner, Florist, Landschaftsarchitekt, aber auch Glücksbringer: Schornsteinfeger","groesse":"eher klein","alter":"viel jünger","woher":"an einem freundlichen Ort, fröhlich, Party oder Disco"},"3":{"sternzeichen":"Krebs, Skorpion, Fische","haarfarbe":"blond, hell, grau oder weiß (Segel); dunkel, kräftig, rötlich, braun (Rumpf)","charakter":"passiv, geduldig, reiselustig, intellektuell","figur":"normal, stattlich, schön","signifikator":"Ein Mensch mit fremdländischem Aussehen, ein Ausländer vielleicht; er philosophiert gern und ist lern- und wissbegierig","beruf":"Alles was mit Reise und/oder Handel zu tun hat: Animateur, Reiseleiter, Reiseverkehrskaufmann, Verkäufer, kaufm. Angestellte mit Sinn für Karriere.","groesse":"groß","alter":"gleich alt, älter","woher":"auf einer Reise, im Reisebüro, im Ausland"},"4":{"sternzeichen":"Stier, Jungfrau, Steinbock","haarfarbe":"rot, braun","charakter":"häuslich, familiär, stabil, gefühlvoll, schwerfällig, Stubenhocker","figur":"stabil, stattlich","signifikator":"Dieser Mensch ist sehr gradlinig und leicht zu berechnen, etwas bequem aber sehr gemütlich.","beruf":"Spezialist, Führungskraft, Handwerker, Hausmeister, Hausfrau, Heimarbeit, von zuhause aus","groesse":"groß","alter":"gleich alt, väterlicher Freund","woher":"im Internet, in sozialen Netzwerken"},"5":{"sternzeichen":"Stier, Jungfrau, Steinbock","haarfarbe":"braun","charakter":"still, standhaft, naturverbunden, analytisch, oft eher pessimistisch und pedantisch","figur":"stattlich","signifikator":"Ein Mensch, der sich gern in der Natur bewegt, geduldig sein kann und ausdauernd; mit Sinn für die Familie und ein gesundes Leben.","beruf":"KrankenpflegerIn, HeilerIn, Berufe im medizinischen Bereich, eventuell auch im Wellness: MasseurIn, Joga-LehrerIn","groesse":"groß","alter":"gleich alt","woher":"im Internet (so verzweigt wie Krone und Wurzel), manchmal ist er/sie schon so nah, und man sieht den Wald vor lauter Bäumen nicht"},"6":{"sternzeichen":"Zwilling, Waage, Wassermann","haarfarbe":"grau, weiß, Haarverlängerungen, Perrücke, wenig Haare oder sogar mit Glatze","charakter":"schwierig, launisch, unzuverlässig, unsicher, unentschlossen, undurchschaubar aber auch praktisch und vorsichtig, Organisationstalent mit Hang zu Abhängigkeiten (Raucher oder Gesellschaftstrinker)","figur":"stattlich, imposant","signifikator":"Dieser Mensch gibt sich nicht so leicht zu erkennen. Achte auf Kleinigkeiten.","beruf":"Forschung, Wissenschaft, Technik, Geisteswissenschaften, Philosophie, aber wenig erfolgreich (zerstreuter Professor) Fotograph, (Lebens-) Künstler, hat oft mit Rückschlägen zu kämpfen","groesse":"groß","alter":"gleich alt","woher":"Bei einem Freiluft-Event oder in einer Disco vor der Nebelmaschine. Es ist noch nicht ganz klar, wen oder was du überhaupt willst."},"7":{"sternzeichen":"Krebs, Skorpion, Fische","haarfarbe":"braun, dunkel, eventuell mit Brille (Brillenschlange)","charakter":"intelligent, schwierig, kompliziert, geheimnisvoll, hintergründig, beobachtend, erfahren","figur":"schlank","signifikator":"ältere Frau, Freundin, Tochter, Mutter, Schwester, Rivalin, Geliebte","beruf":"Psychologe, Berater (auch spiritueller)","groesse":"groß","alter":"gleich alt (aber älter als 25)","woher":"(in einem vergifteten Umfeld) z.B. wenn es auf der Arbeit am schwierigsten ist, dann da; immer da wo es am schwierigsten ist"},"8":{"sternzeichen":"Stier, Jungfrau, Steinbock","haarfarbe":"dunkel, schwarz","charakter":"kränklich, träge, langweilig, traurig, depressiv, ernst, schwach, religiös","figur":"normal","signifikator":"Person mit magischer Anziehungskraft, eventuell mit durchdringendem Blick.","beruf":"Museumswärter, Friedhofsgärtner, Bestatter... Eventuell auch arbeitslos, bzw Lebenskünstler","groesse":"normal","alter":"älter","woher":"(wo es still ist) in einem Museum, Ausstellung, Gedenkstätte, Gallerie, unter Umständen auch auf dem Friedhof"},"9":{"sternzeichen":"Zwilling, Waage, Wassermann","haarfarbe":"rot, gefärbt, Strähnchen, blond","charakter":"freundlich, fröhlich, heiter, kreativ, unbeschwert, unterhaltsam, liebenswürdig, aufmerksam, sensibel, guter Geschmack, erfolgreich","figur":"stattlich, ausladend","signifikator":"Diese Person ist eine gepflegte Erscheinung.","beruf":"kreative Berufe, Florist, Gärtner, Verkäufer, im Baumarkt, in der Gartenabteilung","groesse":"klein","alter":"jünger","woher":"Blumenladen, im Supermarkt bei den Blumen, Baumarkt in der Gartenabteilung, auf einer Ausstellung, Vernisage, auf einer Messe"},"10":{"sternzeichen":"Widder, Schütze, Löwe","haarfarbe":"blond, hellbraun","charakter":"spontan, unauffällig, verletzend, unberechenbar, furchtlos, energisch, leidenschaftlich, gefährlich, aggressiv, brutal","figur":"schlank","signifikator":"Diese Person ist eher zurückhaltend und unauffällig; aber das ist meist nur Tarnung. Das wahre Wesen dieses Menschen offenbart sich erst in der Tiefe und das kann plötzlich geschehen und uns sehr überraschen.","beruf":"Anwalt, Jäger, Polizist, Soldat (Waffen). Arbeiten in der Landwirtschaft, ev. als Bauer (Ernteaspekt)","groesse":"groß","alter":"gleich alt, jünger","woher":"sehr spontan, bei einer Landpartie, eher plötzlich und überraschend"},"11":{"sternzeichen":"Zwillinge, Waage, Wassermann","haarfarbe":"braun, dunkel, schwarz","charakter":"redet viel, streitlustig, zänkisch, kommunikativ, belehrend, einmischend, redseelig, neigt zu vorschnellen Schlüssen","figur":"schlank","signifikator":"Diese Person redet nicht ohne bedacht. Sie weiß um die Wirkung von Worten und wie sie diese für ihre Ziele einsetzen kann.","beruf":"Publizist, Blogger, Autor, ITler, Dolmetscher, Berater","groesse":"normal","alter":"gleich alt","woher":"im Internet, auf einer Flirtline, in einem sozialen Netzwerk, auf einem Vortrag, in einer Disco"},"12":{"sternzeichen":"Zwillinge, Waage, Wassermann","haarfarbe":"hell bis braun","charakter":"instabil, nervös, flatterhaft","figur":"schlank","signifikator":"Tratschtanten, vielleicht auch Oma und Opa","beruf":"Callcenter Agent, TelefonistIn","groesse":"kleiner","alter":"jünger","woher":"im Chat, sozialen Netzwerk"},"13":{"sternzeichen":"Zwillinge, Waage, Wassermann","haarfarbe":"hell, blond, braun","charakter":"kindlich, naiv, kreativ, unselbstständig, offen, neugierig, natürlich, vertrauensseelig","figur":"normal","signifikator":"Ein Mensch der sehr vertrauensseelig ist, vielleicht sogar etwas naiv erscheint, aber dennoch erfrischend unverdorben, herzlich und spontan.","beruf":"ErzieherIn, LehrerIn, HeimleiterIn, arbeitet mit Kindern","groesse":"eher klein","alter":"jünger","woher":"dort wo Kinder spielen oder wo man fröhlich ist (Kino, Restaurant, Bar)"},"14":{"sternzeichen":"Widder, Löwe, Schütze","haarfarbe":"rot, rotbraun, blond","charakter":"mißtrauisch, unehrlich, clever, je nach Typ auch pfiffig, hinterhältig, falsch, neugierig, diplomatisch, gerissen, mit einer gewissen Bauernschläue","figur":"schlank, hager, dürr","signifikator":"Diesem Menschen sind Dynamik, Herausforderung und Abwechslung wichtig. Er geht gern aufs Ganze, koste es was es wolle.","beruf":"alle Arten von Selbstständigkeit; Schnüffler, Detektiv, Polizist, Feuerwehrmann. Manager, dort wo er sein draufgängerisches Wesen in positivere Bahnen lenken kann.","groesse":"normal","alter":"gleich alt","woher":"große Städte wie London, Kopenhagen, Berlin, Hamburg usw."},"15":{"sternzeichen":"Widder, Löwe, Schütze","haarfarbe":"braun, dunkel, schwarz","charakter":"autoritär, stark, gutmütig, stabil, aufbrausend, stattlich, vertrauenswürdig, kräftig","figur":"stattlich, sehr stabil","signifikator":"Niemand kann so arbeiten wie ein Bär, allerdings nur, wenn er von seinem tun absolut überzeugt ist und wenn es ihn auf seinem Weg zum Ziel weiter bringt.","beruf":"Chef, Arzt, Unternehmer, Steuerberater, Schuldirektor... Auf seinem Weg nach oben findet man ihn auch schon mal als Krankenpfleger, Verkäufer bei MC Donalds...","groesse":"groß","alter":"gleich alt, älter","woher":"auf der Arbeit, meist in der Chefetage, auf dem Amt bei Gericht."},"16":{"sternzeichen":"Zwilling, Waage, Wassermann","haarfarbe":"weiß, grau (Sterne), schwarz (des Nachts)","charakter":"klar, spirituell, sensibel, kommunikativ, mit Teamgeist, intuitiv, gefühlvoll, hellsichtig, künstlerisch, empfindlich, zart, fein","figur":"normal","signifikator":"Dieser Mensch liebt schöne Dinge mit viel Ästetik, ist kreativ und verfügt über ein hohes, schöpferisches Potential.","beruf":"Berater, Coach, Astrologe, Astronom, Hellseher, Mentalist, selbstständig arbeitend, mit Menschen (also auch Taxifahrer möglich)","groesse":"normal","alter":"gleich alt","woher":"unter freiem Himmel, auf dem Weihnachtsmarkt, auf der Anna-Kirmis (Jahrmarkt) am Abend, Freiluftevent, Konzert, Sport, Dorffest"},"17":{"sternzeichen":"Zwilling, Waage, Wassermann","haarfarbe":"grau, hellblond, blond","charakter":"flexibel, anpassungsfähig, treu, unnahbar, reformierend, modebewußt, eigenwillig, Stilikone","figur":"schlank","signifikator":"Dieser Mensch ist auf seine bezaubernde Art sehr liebenswert, wenngleich auch etwas verschroben.","beruf":"Hebamme, Designer, Gestalter, Raumausstatter, Herrenausstatter, Friseur, Innenarchitekt","groesse":"normal","alter":"gleich alt","woher":"bei einem Ausflug. Ob in der City zum Bummeln oder in der Ferne spielt dabei keine Rolle."},"18":{"sternzeichen":"Stier, Jungfrau, Steinbock","haarfarbe":"braun, schwarz, ev. Strähnchen","charakter":"treu, zuverlässig, hilfsbereit, aber auch einfallsreich, solide, anhänglich, aufrichtig, gutmütig, tapfer","figur":"schlank, ausser er ist eher der Mopstyp","signifikator":"Dieser Mensch ist ein Freund, man kennt ihn schon und sieht ihn, meist auf eine eher unerotische Art.","beruf":"Hundesitter/-trainerIn, Tierpfleger, Tierarzt, tierlieb, Zoowärter","groesse":"normal","alter":"gleich alt","woher":"im Freundeskreis, eventuell wird man auch verkuppelt oder es ist der Freund eines Freundes... 1000 Mal berührt, 1000 Mal ist nichts passiert..."},"19":{"sternzeichen":"Stier, Jungfrau, Steinbock","haarfarbe":"braun, dunkel, grau","charakter":"ehrgeizig, selbstständig, stur, egoistisch, verschlossen, beharrlich, unbeugsam, introvertiert, einsam, dominant, herausragend, beeindruckend","figur":"schlank","signifikator":"Dieser Mensch erscheint etwas schwierig im Umgang zu sein, ob seiner Unbeugsamkeit und Beharrlichkeit. Aber hinter der rauen Schale steckt ein sanfter Kern.","beruf":"Beamter, Dienstleister, Berufssoldat (Grenzposten), Führungskraft, Berühmtheit","groesse":"lang, groß","alter":"älter","woher":"auf dem Amt, an einer Grenze - das kann auch im übertragenen Sinne gemeint sein"},"20":{"sternzeichen":"Zwilling, Waage, Wassermann","haarfarbe":"grau, hell, gefärbt","charakter":"gesellig, gebildet, steht gerne im Mittelpunkt, extrovertiert, fröhlich, lebhaft, unternehmungslustig","figur":"dick, mollig","signifikator":"Dieser Mensch hat es nicht leicht, sich zu behaupten, da er von der Aufmerksamkeit seiner Umwelt lebt. Das kann mitunter anstrengend sein.","beruf":"alles mit Publikumsverkehr: Verkäufer, Pfleger, Bibliothekar, Gärtner, Künstler, Alleinunterhalter, Zauberer","groesse":"groß","alter":"älter","woher":"in einem Stadtpark, Restaurant, Bücherei, ev. Speed-Dating, im Kaufhaus, auf Veranstaltungen, Disco, in Grünanlagen"},"21":{"sternzeichen":"Stier, Jungfrau, Steinbock","haarfarbe":"weiß, grau (Bergspitze), dunkel","charakter":"standhaft, Fels in der Brandung, gradlinig, rational, nüchtern, diszipliniert, fleißig, strebsam, genau, stur, unnahbar, unterkühlt","figur":"sehr stabil","signifikator":"Dieser Mensch ist eher unaufgeregt, gradlinig und man könnte ihn mitunter als starrsinnig bezeichnen. Seine Verlässlichkeit und Ausdauer gleichen dies vorzüglich aus.","beruf":"Bergwacht, Bergführer, Hirte, Klimaforscher, Geologe, Archiologe, auch alle Berufe, bei der viel Ausdauer gebraucht wird","groesse":"groß","alter":"viel älter","woher":"an dem Ort in deinem Leben, der dir gerade am schwierigsten erscheint und trostlos"},"22":{"sternzeichen":"Zwilling, Waage, Wassermann","haarfarbe":"blond, hell, hellbraun, grau","charakter":"wählerisch, kompromißbereit, kann sich nie recht entscheiden, aber auch tolerant, schnell entschlossen, entscheidungsfreudig, ausgeglichen, ausweichend, zweigleisig","figur":"normal","signifikator":"Eine energievolle Frau, die sehr begeisterungsfähig ist und selbstbewußt.","beruf":"Alle Arten von Nebenjobs, weil der richtige Weg noch gesucht werden muß.","groesse":"normal","alter":"jünger","woher":"auf dem Weg... zur Arbeit vielleicht, ins Büro, zum Einkauf usw."},"23":{"sternzeichen":"Krebs, Skorpion, Fische","haarfarbe":"dunkelbraun, schwarz, mausgrau","charakter":"ängstlich, zweifelnd, nörgelnd, kritiksüchtig, unzufrieden, schüchtern, sorgenvoll, aber auch widerstandsfähig, tiefsinnig (Mäuse leben im Verborgenen), tüchtig","figur":"dicklich","signifikator":"Dies ist ein Mensch, dem ständig etwas fehlt oder verloren geht. Es fehlt ihm an Zufriedenheit, an Motivation oder an Verständnis. Vielleicht aber auch im physischen Bereich: Ein Körperteil, Zähne oder Körperfunktionen.","beruf":"Versicherungsmakler, Banker, Teamleiter, Immobilienmakler","groesse":"eher klein","alter":"gleich alt","woher":"im Supermarkt (Vorratskammer der Neuzeit)"},"24":{"sternzeichen":"Stier, Jungfrau, Steinbock","haarfarbe":"rot, rotbraun, blond","charakter":"liebevoll, großherzig, hilfsbereit, herzlich, uneigennützig, ausgeglichen, aber auch ausgleichend, gradlinig, macht aus dem Herzen keine Mördergrube","figur":"normal","signifikator":"Zumeist ein blonder, gefühlvoller junger Mann, sehr herzlich und von einem bezauberndem Wesen. Man muss ihn einfach mögen. (ev. Liebhaber)","beruf":"selbstständig, in allen Bereichen, wo man mit dem Herzen dabei ist, Kardiologe, Berater, Therapeut","groesse":"normal","alter":"gleich alt, eventuell etwas jünger","woher":"überall ist möglich, folge deinem Herzen."},"25":{"sternzeichen":"Stier, Jungfrau, Steinbock","haarfarbe":"hell, blond","charakter":"verantwortungsbewusst, zuverlässig, konservativ, praktisch, solide, geduldig","figur":"schlank","signifikator":"Dieser Mensch hat ein gutes Selbstverständnis und steht mit beiden Beinen fest auf dem Boden. Er liebt die Lust und die Sinnlichkeit und ist ansonsten sehr solide und hängt an alten Wertevorstellungen.","beruf":"Autoverkäufer, Versicherungsmakler, Immobilienmakler, überall da, wo Verträge unterschrieben werden","groesse":"normal","alter":"gleich alt","woher":"Du kennst diese Person bereits."},"26":{"sternzeichen":"Zwilling, Waage, Wassermann","haarfarbe":"braun, rotbraun, goldbraun, graublond, aschblond","charakter":"gebildet, schweigsam, verschlossen, loyal, neugierig, weise, intelligent, studiert","figur":"normal","signifikator":"Dieser Mensch ist ein verschlossener, lernfreudiger Charakter. Sehr oft weiß er mehr als er vorgibt.","beruf":"Autor, Blogger, Publizist, Lehrer, Journalist, Oberstudienrat, Beamter, Jurist, Rechtshilfepfleger","groesse":"eher klein","alter":"gleich alt","woher":"im Buchladen, Bücherei, auf der Universität, an der Schule"},"27":{"sternzeichen":"Zwillinge, Waage, Wassermann","haarfarbe":"weiß, sehr hell, blond","charakter":"oberflächlich, kommunikativ, geschwätzig, unkonzentriert, entscheidungsfreudig, großzügig in Kleinigkeiten","figur":"sehr schmal, leicht, zierlich und zart","signifikator":"Dies ist ein sehr entschlußfreudiger Mensch, der aber vielleicht auch etwas oberflächlich erscheint. Vielleicht ist es aber auch ein Mensch, den man noch nicht so genau kennt.","beruf":"Briefträger, Post, Internethandel, Webdesigner, alle kommunikativen Berufe, eventuell auch Callcenter Agent","groesse":"eher klein","alter":"gleich alt","woher":"im Chat, auf einer Dating-Hotline, SMS-Portal, durch eine Zeitungsanzeige, Inserat, auf dem Postamt"},"28":{"sternzeichen":"Widder, Löwe, Schütze","haarfarbe":"dunkel, schwarz, grau","charakter":"aktiv, gebend, maskulin","figur":"normal","signifikator":"Diese Person ist dir bereits bekannt.","beruf":"Handwerker, Manager, Selbstständiger, Chef, Führungskraft","groesse":"normal","alter":"gleich alt, älter","woher":"Diese Person kennst du bereits."},"29":{"sternzeichen":"Krebs, Skorpion, Fische","haarfarbe":"dunkelbraun, schwarz","charakter":"passiv, nehmend, feminin","figur":"normal","signifikator":"weibliche Hauptperson, Freundin, Fragestellerin, Herzensdame, Seelenpartnerin","beruf":"alle pflegerischen und heilerischen Berufe","groesse":"normal","alter":"gleich alt, älter","woher":"Diese Dame kennst du bereits."},"30":{"sternzeichen":"Krebs, Skorpion, Fische","haarfarbe":"weiß, grau, blond (Lilie innen)","charakter":"friedlich, harmonisch, sexy, aber mit Sinn für Gemeinschaft und Familie","figur":"normal","signifikator":"Dies ist zumeist ein intelligenter, älterer, vornehmer, langmütiger Mann. Er liebt schöne Dinge und Luxus und ist nicht so leicht zu durchschauen. Er kann dein Ritter sein, aber auch dein wildester Traum.","beruf":"Berater","groesse":"normal","alter":"gleich alt, älter","woher":"an schönen und luxuriösen Orten (Wellnesstempeln), in der Chefetage"},"31":{"sternzeichen":"Widder, Löwe, Schütze","haarfarbe":"hell, blond, rötlich (Sonnenauf- und untergänge)","charakter":"sonniges Gemüt, optimistisch, fröhlich, kämpferisch, energetisch, durchsetzungsfähig, kraftvoll, charismatisch, ehrgeizig, positiv, gewinnend, lebensfroh, aktiv, heiter","figur":"stabil (rundlich), imposant, aber angenehm","signifikator":"Dies ist eine große und charismatische Person. Wenn sie den Raum betritt, wird es scheinbar etwas heller darin. Sie ist sehr erfolgreich und man kann sich diesem gewinnenden Wesen schwer entziehen.","beruf":"erfolgreich selbstständig, in gehobener Position, gute Karrierechancen mit freier Auswahl, auch im Internet erfolgreich","groesse":"groß","alter":"gleich alt, jünger","woher":"Diesem Menschen kannst du überall begegnen. Aber keine Angst, du wirst ihn erkennen."},"32":{"sternzeichen":"Krebs, Skorpion, Fische","haarfarbe":"hell, weiß (der Mond); dunkel, schwarz (nachts)","charakter":"intuitiv, verträumt, gefühlvoll, tiefsinnig, melancholisch, düster, vielleicht ist er auch (schon) berühmt","figur":"dicklich","signifikator":"Dieser Mensch ist eine emotionale, manchmal stimmungsschwankende Person mit künstlerischen Ambitionen und auf dem Wege, berühmt zu werden, wenn er es nicht schon ist. Jedenfalls möchte er es gerne.","beruf":"Sternekoch (Essen hält Leib und Seele zusammen), Schauspieler, Darsteller, Magier, Künstler, gern auf der Bühne (Wobei er gern selbst bestimmt, was für ihn eine Bühne ist.)","groesse":"normal","alter":"gleich alt","woher":"Er wird dich wie magisch anziehen, du kannst ihn nicht verfehlen."},"33":{"sternzeichen":"Widder, Löwe, Schütze","haarfarbe":"blond, dunkelblond, aschblond, grau, manchmal auch mit Rottönen","charakter":"zuverlässig, zuversichtlich, offenherzig, sicher, selbstbewußt","figur":"schlank","signifikator":"Dieser Mensch ist eine Person, die sich immer zu helfen weiß und für jedes Problem auch die richtige Lösung hat, so wie zum Beispiel Mac Gyver.","beruf":"Schlüsselwächter, Physiker, Wissenschaftler im angewandtem Bereich, Abenteurer","groesse":"normal","alter":"gleich alt, jünger","woher":"Fitnessclub, Hotel, Schwimmhalle; überall dort, wo man einen Schlüssel bekommt, um eine Tür zu öffnen"},"34":{"sternzeichen":"Krebs, Skorpion, Fische","haarfarbe":"hell, rötlich, goldblond","charakter":"tiefgründig, materiell","figur":"normal","signifikator":"Dies ist ein tüchtiger, eher materiell eingestellter Mensch, fleißig, wenngleich auch ein wenig (fischig) langweilig.","beruf":"Psychologe, Berater (NLP-Trainer), Unternehmensberater, Geschäftsführer, gute Karrierechancen","groesse":"normal","alter":"gleich alt, jünger","woher":"im Ozeaneum vielleicht, im Supermarkt oder auf dem Wochenmarkt (am Fischstand), aber auch an der Bar (Alkohol)"},"35":{"sternzeichen":"Stier, Jungfrau, Steinbock","haarfarbe":"braun, dunkel","charakter":"fleißig, stoisch, festhaltend, anhänglich, Workaholic","figur":"normal, vielleicht etwas breiter","signifikator":"Dies ist eine solide und vertrauenswürdige Person.","beruf":"auch am Hafen, zur See","groesse":"normal","alter":"älter","woher":"auf der Arbeit, in der Schule, auf der Uni, beim Hobby (außer Haus), im Hafen, auf der Kieler Woche zum Beispiel, im Ausland"},"36":{"sternzeichen":"Widder, Löwe, Schütze","haarfarbe":"dunkel, rotbraun, braun, rot","charakter":"sich selbst wichtig nehmen, egozentrisch, religiös","figur":"normal","signifikator":"Dies ist eine eher seriöse und disziplinierte Person, die in ihrem Leben schon viel Schicksalsschläge erdulden musste.","beruf":"alle freiberuflichen Tätigkeiten, auch Priester, Pastor, spiritueller Lehrer","groesse":"normal","alter":"älter","woher":"in der Nähe einer Kirche oder eines Kreuzes"}};

const CARD_INTROS={"1":"Beginnen wir nun also unsere Reise durch das Lenormand- Kartenspiel und zwar mit der Karte Nummer 1, dem Reiter.\n\nDer Reiter k\u00fcndigt neue Nachrichten an, das Spiel beginnt, die Reise geht los: Etwas Neues tritt in dein Leben und du wirst sehr schnell von jemandem oder von etwas erfahren, das deine Aufmerksamkeit erregt.\n\nDer Reiter ist der Bote, er ist in den meisten F\u00e4llen nur der \u00dcberbringer der (oftmals positiven) Nachricht. Oft m\u00fcssen wir uns auch dar\u00fcber im Klaren sein, dass unser Unmut und unser \u00c4rger auch an die falsche Person gerichtet ist, wenn wir den \u00dcberbringer schlechter Nachrichten ausschimpfen.\n\nWenn wir dem Reiter begegnen, erfahren wir, das etwas auf uns zu kommt, sehr schnell und in kurzer Zeitspanne.\n\nDa der Reiter nichts w\u00e4re, ohne sein Pferd, betrachten wir oft auch das Transportmittel.\n\nNun sind wir nur noch selten mit der Postkutsche unterwegs von einem Ort zum anderen, dennoch k\u00f6nnen wir in diesem Kontext auch das Fahrrad, das Motorrad, das Auto, das Taxi, den Bus oder die Bahn mit in Betracht ziehen.\n\nIn einigen wenigen F\u00e4llen, aber eher selten, geht es auch um den Reiter selbst, um einen fr\u00f6hlichen, jungen Mann, ungest\u00fcm und mutig.","2":"Der Klee im Kartenspiel der Mlle Lenormand steht ein f\u00fcr schnelles Gl\u00fcck oder eine baldige \u00dcberraschung. Der Klee ist wegen seiner gr\u00fcnen Farbe als Gl\u00fcckssymbol schon aus vorchristlicher Zeit bekannt und beliebt.\n\nDie alten Druiden sahen im vierbl\u00e4ttrigen Kleeblatt, schon allein, weil es so selten vorkam, ein Schutzsymbol gegen dunkle Energien und schwarze M\u00e4chte.\n\nDer Legende nach nahm Eva bei der Vertreibung aus dem Paradies ein kleines, vierbl\u00e4ttriges Kleeblatt mit, als Erinnerung an bessere Zeiten. So ist der Klee nicht nur ein altes Gl\u00fcckssymbol, sondern auch ein Symbol f\u00fcr den bevorstehenden Sommer und nahende Liebe und die damit verbundene Hoffnung auf bessere Zeiten.\n\nEin vierbl\u00e4ttriges Kleeblatt ist besonders selten. Es geh\u00f6rt viel Gl\u00fcck und eine gro\u00dfe Portion Ausdauer und Geduld dazu, es zu finden. Wenn man eines erblickt, so soll man es sofort pfl\u00fccken und die Gelegenheit schnell ergreifen... beim Schopfe packen.\n\nDieser Aspekt ist mit der Karte 2 des Lenormand auch gemeint. Das Gl\u00fcck kommt schnell und relativ unerwartet, kann aber auch als Gelegenheit ebenso schnell vor\u00fcberziehen. So hat man bei einem Spaziergang \u00fcber eine gr\u00fcne Wiese eben dieses kleine, vierbl\u00e4ttrige Kleeblatt \u00fcbersehen.\n\nGenau so gut kann man eine gute Gelegenheit \u00fcbersehen, wenn alles um uns her dunkel und grau zu sein scheint. Es geh\u00f6rt also auch Initiative und ein schnelles Ergreifen der willkommenden Gelegenheit dazu.","3":"Nun sticht das Schiff in See und im Spiel der Mlle Lenormand bewegt es sich gleitend und sehr langsam auf seinen Reisen dahin. Aber hat es erst einmal den sicheren Hafen erreicht, verweilt es dort eine Zeit, um dann ein neues Ziel in Angriff zu nehmen.\n\nDie Ereignisse und Situationen, die durch das Schiff repr\u00e4sentiert werden, kommen also eher allm\u00e4hlich und langsam in unser Leben, sie k\u00f6nnen schon lange vor ihrer Ankunft am Horizont wahrgenommen werden. Es sind keine Ereignisse, die pl\u00f6tzlich oder \u00fcberraschend da sind.\n\nWenn das Schiff im Hafen angelangt ist oder ein neues Ereignis Teil unseres Lebens geworden ist, dann bleibt diese Situation auch f\u00fcr l\u00e4ngere Zeit bestehen. Da wir die Ankunft von etwas Neuem also schon l\u00e4nger erwarten und uns darauf vorbereiten k\u00f6nnen, gelingt es uns auch bedeutend leichter, ein neues Verst\u00e4ndnis f\u00fcr etwas oder jemanden zu erlangen und uns in Toleranz zu \u00fcben.\n\nSo ist neben dem Aspekt des Handels, der Ankunft und der Toleranz nat\u00fcrlich auch das Thema Reise eine wichtige Rolle.\n\nJe n\u00e4her die Karte 3, das Schiff dabei an einer Personenkarte liegt, um so mehr Einfluss hat sie auf kommende Ereignisse. Schau nach, ob es in einer direkten Verbindung mit der Personenkarte steht (senkrecht, waagerecht, diagonal, R\u00f6sseln...)\n\nEs handelt sich hierbei also um Ver\u00e4nderungen, die wir zwar steuern k\u00f6nnen, die notwendige Energie, um voran zu kommen, muss allerdings von au\u00dfen hinzu gef\u00fcgt werden. Genau wie das Schiff sind wir abh\u00e4ngig von der Windrichtung und den Meeresstr\u00f6mungen.\n\nDabei ist es egal, ob wir selbst diese Reise unternehmen oder sie im \u00fcbertragenen Sinne unternehmen; oder eine Ver\u00e4nderung in der momentanen Situation auf uns zu kommt: Zu einem gewissen Teil k\u00f6nnen wir das Steuerruder immer noch etwas herum rei\u00dfen.","4":"Zufriedenheit und Wohlergehen\n\nHier finden wir die eigenen vier W\u00e4nde, die Stabilit\u00e4t, Geborgenheit und W\u00e4rme schenken. Was zu uns nach Hause kommt oder was wir nach Hause einladen, will auch eine Weile bleiben. Niemand kauft ein neues Sofa nur f\u00fcr 14 Tage und nur wenige wechseln den Wohnort mit Sack und Pack nur f\u00fcr ein paar Wochen.\n\nDas Haus im Kartenspiel der Mlle Lenormand beschreibt unsere Komfortzone. In ihm finden wir unsere vertraute und intime Umgebung und ebenso unsere nahen Angeh\u00f6rigen als Personen.\n\nEs ist der Ort der Stabilit\u00e4t und Sicherheit, aber auch der mangelnden Flexibilit\u00e4t und Mobilit\u00e4t, die es beeinflussen.\n\nDiese Karte bezieht sich sowohl auf unser physisches zu Hause, als auch auf unser gesamtes Sein, unsere mehr oder weniger festen Denkstrukturen, Glaubenss\u00e4tze, Ansichten und Meinungen, in denen wir uns sicher und geborgen f\u00fchlen, auch wenn sie nicht immer zu unserem H\u00f6chsten, Besten funktionieren.\n\nSo kann das Haus eben diesen sch\u00fctzenden und komfortablen Bereich unseres Lebens symbolisieren, wie auch starre, unbewegliche Gedanken, die uns daran hindern, Dinge zu tun, die wir eigentlich tun sollten, um letztlich gl\u00fccklich zu sein oder es zu werden.\n\nEs geht hier also auch um alle Eigenschaften eines Hauses: Schutz, Sicherheit, Stabilit\u00e4t aber auch Isolation von der Umwelt.\n\nOb diese Karte positiv oder negativ zu bewerten ist, erfahren wir aus den umliegenden Karten und auf welcher Ebene wir das Haus betrachten, erfahren wir mit unserer Intuition.","5":"Leben, denn B\u00e4ume sind die Ausgeburt von Geduld.\n\nSo braucht eine junge Pflanze Geduld und auch Hoffnung, um die erste Phase ihres Lebens zu \u00fcberstehen.\n\nDiese erste Phase k\u00f6nnen wir mit Reife bezeichnen, die einen Aspekt dieser Karte im Lenormand repr\u00e4sentiert.\n\nDie Wurzeln eines Baumes reichen tief ins Erdreich hinein und seine Krone weit in den Himmel. Das machte den Baum bei vielen V\u00f6lkern der Geschichte zu einem heiligen Ort.\n\nBei den Germanen war es Ygdrasil, die Weltenesche; im Hinduismus fand Buddha seine Erleuchtung, als er unter dem Bodhi Baum, einem Banyan Baum, meditierte. Der Bodhi Baum ist seither allen Hindus heilig.\n\nSo gelten B\u00e4ume auch als Vermittler zwischen Himmel und Erde in den Religionen, die diese Art Natur mit einbeziehen.\n\nEgal ob es regnet, st\u00fcrmt, schneit oder die Sonne brennt, der Baum verbleibt an seinem Platz im Leben und dr\u00fcckt aus, was er ausdr\u00fccken muss. Genau so tun wir oft genau das, was wir in unserem Leben f\u00fcr unsere Aufgabe bzw unsere Bestimmung halten.\n\nDer Baum repr\u00e4sentiert also unseren Platz im Leben mit unserem Lebenssinn und dauerhaften Zielen. So ist der Baum vorwiegend als positive Karte im Lenormand zu deuten, die auf Best\u00e4ndigkeit und Nachhaltigkeit in unseren Beziehungen verweist und auf eine lange Zeitspanne.","10":"Die Karte der Sense hat im Kartenspiel der Mlle Lenormand, grob gesagt eine positive und eine negative Bedeutung. Zum einen ist sie ein wichtiges Erntewerkzeug und wer sie gebraucht, verf\u00fcgt \u00fcber Erfahrung im Umgang, sonst funktioniert sie nicht.\n\nDie Sense steht hier unter anderem f\u00fcr das Abtrennen, Abernten oder Durchschneiden einer Sache oder einer Angelegenheit. Der Gebrauch einer Sense erfordert Initiative und Erfahrung.\n\nAu\u00dferdem hat sie eine scharfe Schneide und die Verletzungsgefahr ist sehr gro\u00df, gerade wenn man unge\u00fcbt ist im Umgang, und das, was sie zerschnitten hat, kann man nur m\u00fchselig wieder beieinander flicken.\n\nUm unserer Intuition ein wenig auf die Spr\u00fcnge zu helfen, k\u00f6nnen wir davon ausgehen, dass die Verletzungsgefahr an der Spitze der Sense am gr\u00f6\u00dften ist, und dass der R\u00fccken des Sensenblattes zu der Seite hin zeigt, die zu ernten ist.\n\nWer einmal einen Bauern bei der Arbeit mit der Sense beobachten durfte, wei\u00df das vor dem Ausholen zum n\u00e4chsten Schnitt der R\u00fccken des Sensenblattes zum Erntegut zeigt.\n\nWollen wir einen \u00dcberblick \u00fcber die Gesamtsituation erlangen, so k\u00f6nnen wir schauen, wie die Karte der Sense zur Personenkarte liegt:\n\nWenn die Spitze des Sensenblattes von der Person weg zeigt, so bringt die Sense gerade die Ernte ein. Meistens steht dieser Gewinn dann auch in Verbindung mit voran gegangenen Bem\u00fchungen.\n\nWenn die Spitze jedoch auf die Personenkarte zeigt, dann wird etwas von ihm getrennt oder es geht verloren. Was genau es ist, zeigen auch hier wieder die umliegenden Karten. In diesem Fall hat sie dann oft ihre negative Bedeutung.","11":"Diskussionen und Meinungsverschiedenheiten im allgemeinen oder auf einen intensiven Meinungsaustausch hin.\n\nMit den Ruten schl\u00e4gt man aufeinander ein, f\u00fcgt sich allerdings keine oder nur wenige bleibende Verletzungen zu. Man haut sich eben das ein oder andere um die Ohren.\n\nWer aus diesem Schlagabtausch als Sieger hervor geht ist allerdings hiermit noch nicht entschieden. Diese Karte sagt nur aus, dass es anstrengend sein kann. Jedenfalls f\u00fcr Menschen, die sich mit Auseinandersetzungen schwer tun.\n\nManchmal ist es aber auch so, dass es ein heimliches Vergn\u00fcgen bereitet, genau das Wort zu suchen und auch zu finden, auf das sich der Zorn st\u00fcrzen kann. Manche nennen es streits\u00fcchtig sein oder z\u00e4nkisch.\n\nEs kann sein, das zeigen die umliegenden Karten, dass sich das Thema f\u00fcr den Streit schon seit l\u00e4ngerem abzeichnet, die offene Auseinandersetzung nur eben noch fehlt. In dieser Situation ist es immer noch m\u00f6glich, einen Streit zu vermeiden und sich bereits in diesem Moment auf die m\u00f6glichen Konsequenzen vorzubereiten.\n\nDas Symbol dieser Karte l\u00e4sst uns vermuten, dass der Streit auf Augenh\u00f6he ausgetragen wird. Jeder der beiden Parteien hat, im wahrsten Wortsinn schlagende Argumente. Die offene Aussprache kann aber auch bewirken, dass ein Kompromiss gefunden wird.\n\nWenn es irgend geht, sollten wir den sich anbahnenden Konflikt vermeiden. Nat\u00fcrlich steht es aber auch jedem frei, sich auf den Streit vorzubereiten und sich die passenden Argumente zurecht zu legen...","13":"Die Karte des Kindes im Spiel der Mlle Lenormand steht oft f\u00fcr einen 13 Neuanfang, etwas Kleines, f\u00fcr die Jugendlichkeit oder aber auch f\u00fcr kindliches und naives Denken. Damit kann in Kombination mit anderen Karten ein neues Baby ebenso gemeint sein, wie ein neues Projekt, das \"unser Baby\" werden will.\n\nDas Kind besitzt noch einen st\u00e4rkeren Zugang zur feinstofflichen Welt und erobert sich seinen Lebensraum intuitiv. Es ist noch immer mystisch mit allem verbunden und erkennt die unsichtbare Welt noch ohne die Scheuklappen der erwachsenen Menschen.\n\nF\u00fcr das Kind sind Prinzessinnen, Ritter, Reiter und Drachen durchaus im Bereich des M\u00f6glichen.\n\nSo kann uns die Karte darauf hinweisen, dass wir mit einem neuen Blick auf die Dinge schauen sollen, die in der N\u00e4he dieser Karte zu liegen kommen.\n\nSind es positive Karten, kann es sein, dass wir die guten Seiten einer Situation oder eines Menschen mehr in Betracht ziehen sollten. Zusammen mit nicht ganz so positiven Karten k\u00f6nnte das Kind uns den Hinweis geben, dass wir nicht l\u00e4nger so blau\u00e4ugig an eine Sache heran gehen sollen, und es soll m\u00f6glicherweise vor einer groben Entt\u00e4uschung gewarnt werden.\n\nVielleicht befinden wir uns aber auch gerade in einer wichtigen Entscheidungsphase, in der wir mit zu wenig Informationen eventuell voreilige Schl\u00fcsse ziehen w\u00fcrden.\n\nF\u00fchlen wir in diesem Falle zuerst in uns hinein, was r\u00e4t uns unsere Intuition? Kindliche Vorfreude? Unbehagen? Durch die N\u00e4he dieser Karte zur mystischen, unsichtbaren Welt ist es hier ganz besonders sinnvoll, auf unsere Intuition zu vertrauen, sie anzusprechen und aufzurufen, uns den Weg in die richtige Richtung zu weisen.","14":"Der Fuchs im Spiel der Mlle Lenormand ist ein hinterlistiger R\u00e4uber und sind wir ehrlich, nat\u00fcrlich kann auch die Fuchsschl\u00e4ue gemeint sein, die Klugheit und das Wandern zwischen Licht- und Schattenreich, aber so nah an der Wirklichkeit, wie diese Karten sind, handelt es sich hier eben um die 14 Aspekte Hinterlist und Betrug.\n\nImmerhin jagt der Fuchs an der Oberfl\u00e4che und wohnt unter der Erde und macht ihn so zum Vermittler zwischen den Welten, wenn man ihn als reines Krafttier betrachtet. Und wenn wir in den Lenormands nach Katzen suchen, sehen wir uns immer auch den Bereich um den Fuchs herum an, da der Fuchs der Katze n\u00e4her ist als dem Hund.\n\nBei allem Wohlwollen: Der Fuchs ist und bleibt ein H\u00fchnerdieb.\n\nSeit einiger Zeit versucht die Werbung, das Image des Fuchses wieder etwas aufzupolieren, f\u00fcrs Bausparen vielleicht oder f\u00fcr noch wei\u00dfere W\u00e4sche... dennoch: Was beim Fuchs liegt l\u00e4uft irgendwie in eine falsche Richtung, und nach meiner Erfahrung ist das in mehr als 90% der Fall.\n\nIrgendjemand oder irgendetwas arbeitet mit einem falschen Spiel gegen uns, gerade dann, wenn uns die Karte des Fuchses sehr nahe liegt.\n\nDas kann eine gute Freundin sein, die hinter unserem R\u00fccken schlecht \u00fcber uns redet (was mehr an mangelndem Selbstvertrauen seitens der Freundin liegt, als dass man sich etwas hat zu Schulden kommen lassen, aber das ist ein anderes Thema), um sich selbst in ein besseres Licht zu r\u00fccken oder jemand lockt uns mit verlockenden Versprechungen, um seine eigenen Ziele uns gegen\u00fcber durchzusetzen und in die Irre zu f\u00fchren.\n\nFalls die Karte des Fuchses sehr nahe bei der Personenkarte liegt, geht es um eine unmittelbare T\u00e4uschung, von der wir bewusst noch \u00fcberhaupt nichts ahnen.","15":"Kraftvoll und unbesiegbar schreitet der B\u00e4r durch den Wald. Die Germanen sahen in ihm den K\u00f6nig der W\u00e4lder, dem niemand gef\u00e4hrlich werden konnte. Selbstbewusst und mit festen Schritten geht er sein Tagwerk an. 15\n\nSo repr\u00e4sentiert der B\u00e4r im Kartenspiel der Mlle Lenormand St\u00e4rke, Autorit\u00e4t und Macht. Dabei kann sowohl die eigene St\u00e4rke und Dominanz gemeint sein aber auch Autorit\u00e4ten, wie die eigenen Eltern, ein Chef, eine Beh\u00f6rde und so etwas.\n\nAls K\u00f6nig des Waldes steht der B\u00e4r f\u00fcr Stabilit\u00e4t, Ordnung und Autorit\u00e4t ein. So ist er in unserer wirklichen Welt oft ein Repr\u00e4sentant des eigenen Chefs oder einer anderen vorgesetzten Person, die in unserem Leben eine gewisse Autorit\u00e4t mitbringt.\n\nEgal in welche Richtung es sich bewegen wird, es ist immer ein sehr nachhaltiges Erlebnis, mit einem B\u00e4ren konfrontiert zu sein.\n\nManchmal, wenn die Fragestellerin einen Geliebten hat oder heimlich eine neue Beziehung eingegangen ist, so wird der Mann, dem augenblicklich ihr Herz geh\u00f6rt, vom Herrn repr\u00e4sentiert. Der B\u00e4r kommt uns dann aus, wie der w\u00fctende Ehemann. Gl\u00fccklich ist man dann, wenn er noch wie ein Brummb\u00e4r im murmeligen Winterschlaf steckt und nicht geweckt wird.\n\nAuch hier ist zu beachten, je n\u00e4her die Karte des B\u00e4ren zum Fragesteller liegt, umso einflussreicher sind die Energien und um so bedeutender das Ereignis.\n\nAbgesehen von der Tatsache, dass der B\u00e4r eine bestimmte Person darstellt, kann diese Karte auch f\u00fcr eine Situation stehen oder f\u00fcr den Ausgang einer Situation.","16":"Kommen wir nun zu meiner absoluten Lieblingskarte: Den Sternen. Im Lenormand wie auch im Tarot freu\u00b4 ich mich jedes mal so sehr, wenn ich sie sehe, gerade dann, wenn die Situation kompliziert zu sein scheint.\n\nDie Sterne sind f\u00fcr mich \"das heilsame Wunder\", dass uns ereilt, gerade in aussichtslosen Situationen. Die Sterne schenken uns den Durchblick und die 16 Klarheit, die in manch verfahrener Kiste so dringend notwendig sind.\n\nGerade im Lenormand ist dies eine der h\u00f6chsten und besten Karten. Auch oder gerade weil sie so unscheinbar mit Nummer 16 daher kommt, versteckt sich in der Quersumme doch die Nummer 7, die Zahl des Gl\u00fccks und der absoluten Erfolgs.\n\nWenn sie nahe dem Fragesteller liegt, so greift dieser buchst\u00e4blich nach den Sternen. Wie erfolgreich er dabei ist, zeigen dann im einzelnen die umliegenden Karten.\n\nIn allen Kulturen der Welt sind die Sterne, neben der Sonne und dem Mond, die h\u00f6chsten Repr\u00e4sentanten des G\u00f6ttlichen und der himmlischen Kr\u00e4fte \u00fcberhaupt.\n\nDiese Gl\u00fcckskarte steht im \u00fcbertragenen Sinne in einer engen Beziehung zum spirituellen Ausdruck des Fragestellers.\n\nSoll auf die Frage nach der Spiritualit\u00e4t und in welcher Form sie am Besten Ausdruck finden sollte, schaut man sich immer auch die Karten um die Sternenkarte an, um treffende Aussagen zu finden.\n\nDort, wo wir in den acht umliegenden Karten auch den Beruf einer bestimmten Person finden, finden wir in dieser Frage auch die Berufung und das Medium, das der Fragesteller als besten Ausdruck seiner Spiritualit\u00e4t nutzen kann. Solltest du nicht sicher sein, kannst du dich gerne an mich wenden und mir eine E-Mail schreiben, an annabenoir@ymail.com oder auf unserem Blog nachsehen unter: annadas.wordperss.com.","17":"Kindersegen\n\nWird der Storch als Symbol angesprochen, so steht er f\u00fcr Gl\u00fcck, Kindersegen und Fruchtbarkeit. Hier bei uns in Mecklenburg ist der Tag im Jahr ein besonderer Gl\u00fcckstag, an dem man den ersten Storch fliegen sieht.\n\nIm Lenormand symbolisieren die St\u00f6rche eine Ver\u00e4nderung oder einen Ortswechsel. Da die St\u00f6rche zu den Zugv\u00f6geln geh\u00f6ren, ist der Umzug mit ihnen in einem gro\u00dfen Zusammenhang zu sehen. Diese Ver\u00e4nderung oder der Umzug findet meist geplant statt, ohne viele \u00dcberraschungen und selten unvorbereitet. Die St\u00f6rche sind kein pl\u00f6tzlicher Schicksalsschlag. Sogar ein Baby kommt selten so pl\u00f6tzlich, dass seine Ankunft nicht schon vorher bemerkt werden w\u00fcrde.\n\nStorchenpaare sind au\u00dferordentlich treu und bleiben ihr ganzes Leben lang zusammen. Daher finden wir die St\u00f6rche auch immer dann in der N\u00e4he des Fragestellers, wenn sich eine Ver\u00e4nderung in der Beziehung oder Partnerschaft ank\u00fcndigt.\n\nWeniger bekannt ist der Brauch, dass man mit den St\u00f6rchen eine Prognose f\u00fcr den bevorstehenden Winter abgeben kann: Sind schon vor dem Barthel- Tag (24.August) schon alle Storchenpaare in Richtung S\u00fcden davon geflogen, ist ein kalter Winter zu erwarten.\n\nSind nach dem 24. August noch St\u00f6rche im Lande zu sehen, wird der Winter mild. Ich selbst beobachte dieses Ph\u00e4nomen schon seit vielen Jahren und die St\u00f6rche haben die meiste Zeit Recht.\n\nSollte unsere eigene Personenkarte nah bei den St\u00f6rchen liegen, so werden wir selbst in eine Ver\u00e4nderung hinein gehen oder wir befinden uns bereits im Wandel.","18":"Der Hund im Kartenspiel der Mlle Lenormand ist ein wichtiger Hinweis auf langfristige Zuverl\u00e4ssigkeit in Bezug auf eine Situation bzw auf eine konkrete Person in unserem privaten Umfeld.\n\nVon allen Tieren, die irgendwann zum Haustier wurden, ist der Hund dem Mensch am n\u00e4chsten und dem gemeinsamen Leben am meisten angepasst. Ein guter Hund ist ein treuer Begleiter und liebt sein Herrchen bis in den Tod. Manchmal sogar noch dar\u00fcber hinaus.\n\nN\u00e4mlich immer dann, wenn die Herrchen in den Urlaub gefahren sind 18 zum Beispiel , und dann nichts mehr fressen m\u00f6chte. Oder wenn der Hund selbst trauernd auf dem Grab des Herrchens zu sterben kommt.\n\nEs geht also um etwas oder jemanden, der uns treu ist, den wir so schnell auch nicht los werden, selbst wenn wir es wollten.\n\nIn den meisten F\u00e4llen ist es allerdings positiv zu bewerten. Es handelt sich um jemanden, der sich f\u00fcr uns einsetzt, hinter uns steht und auf den wir uns vollkommen verlassen k\u00f6nnen.\n\nSollte diese Karte in der N\u00e4he deines Herzensmannes zu liegen kommen, hast du wahrlich einen Goldschatz an der Angel. Sei froh und genie\u00dfe die Zeit, er wird dich auf H\u00e4nden tragen.\n\nSollte es nicht in erster Linie um eine wirkliche Person gehen, dann kann uns diese Karte auch auf die Treue zu unseren eigenen Werten und \u00dcberzeugungen hinweisen, darauf, dass wir eben uns selbst treu bleiben sollten.\n\nTreue fragt nicht. Treue und Glaube sind sehr nah miteinander verbunden. So ist die Treue der Spross, der sich aus dem Glauben erw\u00e4chst. Ich kann nur voll und ganz hinter jemandem oder etwas stehen, wenn ich an ihn glaube.","19":"Der Turm in den Lenormandkarten symbolisiert eine Trennung von der \u00e4u\u00dferen Welt und bildet sich manchmal regelrecht zu einem Gef\u00e4ngnis heraus, in das wir uns selbst einsperren, manchmal aus Angst oder aus Furcht, manchmal aber auch aus einem zu geringem Selbstwertgef\u00fchl heraus.\n\nDer Turm steht solide und unbeweglich an seinem Platz und zeichnet sich durch Stabilit\u00e4t und Unangreifbarkeit aus. In den meisten F\u00e4llen hat der Turm in den Abbildungen auf den Karten weder T\u00fcr noch Fenster und wenn doch, sind sie nur ganz klein und schwer zu durchschreiten. Das weist darauf hin, das uns der Turm von der \u00e4u\u00dferen Welt trennt. So kann es auch ein Grenzturm sein am Ende des Landes, aber auch ein Hinweis auf innere Blockaden, die uns daran hindern, mit der Welt, die uns umgibt auf eine nat\u00fcrliche Art und Weise in Kontakt zu treten.\n\nFinden wir den Turm nahe der Personenkarte, so steht er, sei es nun von Innen oder von Au\u00dfen, sehr eng mit unserem Selbst in Verbindung und spielt in unserem Leben bereits eine wichtige Rolle.\n\nEin weiterer Aspekt dieser Karte ist die Aussicht. So kann uns der Turm arg dazu auffordern, den Standpunkt zu wechseln; entweder eine Situation oder eine Person mit ihrem Verhalten uns gegen\u00fcber, von einer anderen Warte aus zu betrachten oder vielleicht auch wieder etwas auf den Boden der Tatsachen zur\u00fcckzukehren.\n\nWelcher Aspekt genau gemeint ist erfahren wir wieder mit unserer Intuition und mit unserer gut ausgebildeten Beobachtungsgabe.","20":"Publikumsverkehr\n\nIm Park spielt sich das bl\u00fchende Leben ab. Man geht flannieren, zeigt sich und wird gesehen. Man schlie\u00dft Gesch\u00e4fte, Wetten (auf der Pferderennbahn) oder Ehen ab und am\u00fcsiert sich k\u00f6niglich.\n\nHier kann also ein \u00f6ffentlicher Platz gemeint sein, ein Kino vielleicht oder eine B\u00fccherei, ein Theater oder auch ein richtiger Park, mit B\u00e4umen, Str\u00e4uchern, Hecken und Rosen...\n\nIn jedem Falle aber steht der Park f\u00fcr einen Lebensbereich, der von vielen Menschen wahrnehmbar oder in irgend einer Art zug\u00e4nglich ist. Der Park ist somit die B\u00fchne, der Ort, dort, wo sich Menschen begegnen. In unserer heutigen Zeit m\u00fcssen wir mit einbeziehen, dass auch virtuelle Netzwerke, wie zum Beispiel Facebook, ICQ oder Spin usw, eine solche B\u00fchne f\u00fcr die Begegnung in aller \u00d6ffentlichkeit bieten k\u00f6nnen.\n\nUnserem Gehirn ist es gleich, ob wir unseren K\u00f6rper in die Begegnung mit einbeziehen oder sich alles nur im Kopf abspielt, wer einmal im Kino bei einem Film geweint hat, wei\u00df, wovon ich rede.\n\nEin weiterer Aspekt dieser Karte kann auch eine \u00f6ffentliche Gemeinschaft sein, ein Verein, eine Gartenanlage, eine Kirchengemeinde oder eine Singegruppe. Was genau gemeint ist, erfahren wir in den umliegenden Karten.\n\nDie Deutungsm\u00f6glichkeiten beim Park sind sehr vielf\u00e4ltig und universell. Der Park bringt Licht ins Dunkle, wenn es darum geht, den Rahmen einer Sache oder einer Situation genauer einzugrenzen.","21":"Wenn ich beim Anblick dieser Karte einen meiner Sch\u00fcler sagen h\u00f6re: Hier haben wir eine Blockade... dem werf ich so alle Karten an den Kopf, dessen kannst du dir sicher sein.\n\nWenn wir dem Berg das Wort Blockade anheften, so kann er sich augenblicklich in eine sich selbst erf\u00fcllende Prophezeiung verwandeln, und dann sehen wir den Berg vor lauter Hinkelsteinen nicht. Dann reduzieren wir den Berg auf einen einzigen Aspekt und sind alsbald fertig mit dem Kartenlegen.\n\nNat\u00fcrlich deutet der Berg auf Hindernisse hin, aber er hat noch weit aus mehr zu bieten. Er k\u00f6nnte ein gro\u00dfes Ziel sein, das wir in Angriff genommen haben und vor dem wir in die Knie zu gehen drohen. Es kann sein, dass wir einen Urlaub in die Berge unternehmen wollen oder sollten oder es kann auch m\u00f6glich sein, dass wir uns bei der vor uns liegenden Aufgabe zuerst auf unsere Fu\u00dfspitzen konzentrieren sollen, wenn wir uns auf den Weg machen.\n\nUnd: Hey, es gibt Menschen, die lieben Bergsteigen.\n\nEs gibt auch ein gefl\u00fcgeltes Wort: Wenn der Prophet nicht zum Berg kommt... So siehst du: es gibt einige M\u00f6glichkeiten, sich mit dem Berg auseinander zu setzen und wenn wir ihm begegnen in unserem Kartenbild, und uns f\u00e4llt als erstes die Blockade ein, sollten wir ebenso schnell weiter denken, dass hinter m\u00f6glichen Blockaden noch eine Menge Geschenke verborgen sein k\u00f6nnen.\n\nIn vielen F\u00e4llen liegt der Hintergrund, den die Lenormandkarten durch den Berg zur Sprache bringen wollen, in uns selbst verborgen.","22":"Die Wege im Kartenspiel der Mlle Lenormand zeigen wichtige Entscheidungen an, die getroffen werden m\u00fcssen. Es sind die Weggabelungen des Lebens, die Scheidewege, an denen die Weberk\u00f6nigin Arianrhod mit ihrem Spinnrad unser Schicksal webt.\n\nVielleicht erinnerst du dich an das Buch: \"Die Prophezeiung von Celestine\", als John nicht mehr weiter wusste und sich entscheiden musste, ob er den linken oder den rechten Weg einschlagen sollte, entschied er sich f\u00fcr den Weg, der ihm heller erschien als der andere.\n\nDie Hauptbedeutung dieser Karte liegt in der Bewusstwerdung der Wahl, die wir treffen m\u00fcssen, oder eben dass es unsere eigene Wahl war, die uns an diesen Punkt in unserem Leben gebracht hat.\n\nDieses ins Bewusstsein rufen hat einen entscheidenden Vorteil: Wir 22 werden wieder Herr unserer Lage, wenn wir die Verantwortung f\u00fcr unser Leben \u00fcbernehmen. Dann sind wir nicht mehr Opfer eines Schicksals, das uns auferlegt wurde.\n\nWenn wir uns erinnern, dass wir selbst es sind, die die Entscheidungen treffen oder getroffen haben, k\u00f6nnen wir den Weg, den wir gegangen sind, in Gedanken oder in der wirklichen Welt zur\u00fcck laufen und eine neue Wahl treffen.\n\nWir sehen die Karte der Wege als Option, uns all unsere Entscheidungen noch einmal zu \u00fcberdenken, Frieden zu schlie\u00dfen und mutig unseren Weg voran zu gehen, hin zu den n\u00e4chsten mutigen Entscheidungen.\n\nManchmal weisen uns die Wege auch auf eventuelle Ablenkungen hin, auf Situationen, in denen wir von Wege abgekommen sind oder unter zu wenig Konzentration oder Ernsthaftigkeit leiden.","23":"Ritzen. Es sind kleine R\u00e4uber, sie nehmen unsere Vorr\u00e4te, klauen uns Energie, die wir zum Leben brauchen, meist unbemerkt unter unseren Augen.\n\nWenn diese kleinen frechen Biester sich ihrer Sache sicher werden, tanzen sie uns auf der Nase herum, sie machen mit uns was sie wollen, werden lauter und zeigen sich alsbald sogar am helllichten Tage.\n\nDie M\u00e4use im Kartenspiel der Mlle Lenormand symbolisieren den heimlichen, allm\u00e4hlichen Verlust von Dingen, auf die wir nicht genug aufpassen. Das muss nicht immer nur schlecht sein, in der N\u00e4he von negativen Karten sind die M\u00e4use immer gern gesehene G\u00e4ste und arbeiten wie die Zeit f\u00fcr uns.\n\nIn den meisten F\u00e4llen stehen die M\u00e4use aber f\u00fcr etwas, das uns verloren 23 geht, das f\u00fcr uns lieb und teuer war, nur weil wir nicht genug darauf acht gegeben haben. M\u00e4use k\u00f6nnen aber auch nur das verputzen, das wir zuvor im Stich gelassen haben oder wobei wir unserer Sache all zu sicher waren.\n\nDie M\u00e4use warnen uns vor dem Verlust von Dingen, Menschen oder Beziehungen, auf die wir nicht genug achten und deren Pflege wir vernachl\u00e4ssigen. Wenn wir im gro\u00dfen Blatt eine direkte Verbindung von den M\u00e4usen zur Personenkarte herstellen k\u00f6nnen, sollten wir diesem Thema besondere Aufmerksamkeit widmen.","24":"Liebe ist immer eine Herzensangelegenheit. Der Verstand hat hier nicht mehr all zu viel zu sagen. Wusstest du, dass beim Verliebtsein die genau gleichen Areale im Gehirn aktiviert werden, die auch aktiv sind, wenn wir einer Sucht nachgeben?\n\nDas Herz bezeichnet menschliche Beziehungen, Anziehungen und Zuneigungen aller Art an. Denn in den meisten F\u00e4llen, in denen wir die Karten nach Antworten befragen, geht es um die mehr oder weniger gro\u00dfe Liebe.\n\nEs kann sich aber auch um die Liebe zu etwas handeln, dass Gefahr l\u00e4uft, zu einer Passion zu werden. Vielleicht das Er die Beziehung zu seinem Wagen mehr pflegt als zwischenmenschliche Beziehungen oder SIE mehr mit der Kontrolle des Haushalts und der Familienbande besch\u00e4ftigt ist, als sich den 24 reinen Gef\u00fchlen der Liebe hinzugeben.\n\nDas ist nat\u00fcrlich sehr klischeehaft dargestellt, es ist nur zum besseren Verst\u00e4ndnis. Dar\u00fcber hinaus muss es beim Herzen nicht immer nur um die Liebe zwischen Mann und Frau gehen, es kann auch eine innige Freundschaft symbolisieren oder die herzliche Zuneigung zwischen Mutter und Tochter, Vater und Sohn oder anders herum...\n\nJe n\u00e4her die Karte des Herzens der Personenkarte liegt, um so bedeutsamer ist der Aspekt der Partnerschaft zu jemandem oder etwas im Leben dieser Person. Bei der Deutung des Herzens aus dem Kartenblatt heraus ist es auch wichtig zu pr\u00fcfen, ob noch eine dritte Person in der Beziehung eine heimliche Rolle spielt. In 9 von 10 F\u00e4llen allerdings ist das Herz positiv zu deuten und weist uns darauf hin, wo wir unsere wahre Liebe finden.","25":"Der Ring im Kartenspiel der Mlle Lenormand steht f\u00fcr dauerhafte Beziehungen aller Art, in seinem Ursprung aber f\u00fcr die Verlobung und baldige Hochzeit, sp\u00e4ter dann auch f\u00fcr Vertr\u00e4ge aller Art, f\u00fcr Einigungen und Abmachungen.\n\nSo ist der Ring ist eben auch ein Verbindungssymbol. Er zeigt uns an, woran wir uns gebunden f\u00fchlen, mitunter aber auch, wovon wir uns gerne l\u00f6sen m\u00f6chten.\n\nDie Ringe geh\u00f6ren zu den \u00e4ltesten Schmuckformen \u00fcberhaupt. Die runde Form symbolisiert den Kreislauf des Lebens und die Ewigkeit.\n\nAls Ehe- oder Verlobungsring ist er auch ein sichtbares Liebesbekenntnis zwischen dem Herzensmann und der Herzdame.\n\nDer Ring dr\u00fcckt aus: Ich bin meinem Liebsten, meiner Liebsten treu, ich habe mich verpflichtet treu zu sein. Ein Ehering ist nat\u00fcrlich auch ein Zeichen f\u00fcr Zuverl\u00e4ssigkeit und feste Werte, die die Ehepartner damit zum Ausdruck bringen. 25 Das Material der m\u00e4chtigsten Ringe aller Zeiten ist immer Gold. Das kommt auch auf den meisten Illustrationen der Lenormandkarten zum Ausdruck. Gold steht nicht nur als Edelmetall f\u00fcr die Wertsch\u00e4tzung der Verbindung mit jemandem oder mit etwas (ein liebendes Herz wiegt oft ebenso schwer, wie ein ganzes K\u00f6nigreich), sondern mythologisch auch f\u00fcr die Sonne und das Bewusstsein.\n\nWir erkennen, wie m\u00e4chtig dieses Symbol und wie viel Kraft die Energie dieser Karte hat. In ihrer Umgebung erkennen wir eben auch, um welche Art der Verbindungen es sich handelt.","26":"Das Buch in den Karten der Mlle Lenormand ist eine der interessantesten Karten dieses Spieles. Da sie alle Arten von Geheimnissen abbildet, so auch verborgene Wahrheiten und besonderes Wissen, wird es immer dann spannend, wenn das Buch in einer direkten Linie mit der Person des Interesses liegt. Nichts ist spannender, als ein Geheimnis zu l\u00fcften, das liegt in unserer Natur.\n\nDas Buch steht aber auch f\u00fcr eine Ansammlung von Wissen, einer oder mehrerer interessanter Geschichten und in Form gegossener Gef\u00fchle. Das Buch, das geschriebene Wort an sich, \u00fcbt seit der Zeit, als das Wort den Menschen eroberte, eine ungebrochene Faszination auf uns aus.\n\nEin Buch bewahrt die Gedanken eines Menschen auf unbegrenzte Zeit, es macht bestimmte Teile des Bewusstseins auf diese Weise unsterblich.\n\nIm Lenormand will uns diese Karte in erster Linie auf ein Geheimnis hinweisen. Es tritt als das sprichw\u00f6rtliche \"Buch mit sieben Siegeln\" in unser Leben. Wir sollen so alle Aufmerksamkeit und Konzentration darauf richten, gerade dann, wenn es in einer direkten Beziehung zu einer Personenkarte, die f\u00fcr uns wichtig ist, in Erscheinung tritt. In einigen anderen F\u00e4llen steht das Buch auch mit unserer Ausbildung in Zusammenhang. Dies ist zum Beispiel bei jungen Menschen oft der Fall, f\u00fcr die das Spiel der Mlle Lenormand ausgelegt wird.\n\nWir k\u00f6nnen davon ausgehen, das der Aspekt, der dem Buchr\u00fccken des Buches auf unseren Karten zugewandt ist, einen f\u00fcr uns noch unbekannten Aspekt repr\u00e4sentiert. Die Karten, die auf die offenen Buchseiten folgen, zeigen an, was sich als Geheimnis bald offenbart.\n\nIn manchen Abbildungen dieser Karte im Lenormand wird allerdings auch ein offenes Buch dargestellt, dann k\u00f6nnen wir diese Unterscheidung leider nicht vornehmen.","27":"So richtig von Hand geschriebene Briefe? Liebesbriefe vielleicht sogar? Wann hast du deinen letzten Liebesbrief geschrieben?\n\nSo kann ein Brief also auch in Form einer Privatnachricht in unserem bevorzugten sozialen Netzwerk zu uns kommen, als E- Mail oder als SMS.\n\nEr kann als kleiner Zettel auf unserer Kommode liegen oder hinter dem Scheibenwischer unseres Autos klemmen. Ja die Nachricht kann uns sogar m\u00fcndlich erreichen, als Anruf oder als Freund, der gerade zur T\u00fcre herein kommt.\n\nEine weitere, in diesem Zusammenhang besonders wichtige Qualit\u00e4t dieser Karte ist die Oberfl\u00e4chlichkeit. Die Nachricht wird in eine Richtung 27 abgeschickt, ohne besondere Wertsch\u00e4tzung einer Antwort.\n\nOft kann es auch vorkommen, dass in einer geschriebenen Nachricht sch\u00e4rfere Worte Verwendung finden, als man sich zu sagen trauen w\u00fcrde. So kann es passieren, dass wir auf eine einmal ge\u00e4u\u00dferten Meinung ein regelrechter Shitstorm \u00fcber uns herein bricht.\n\nAuch kann auf einen Brief ja auch nur mit Verz\u00f6gerung geantwortet werden und man kann sich mit dem Lesen der Nachricht Zeit lassen bzw selbst entscheiden, ob man sie \u00fcberhaupt lesen m\u00f6chte.","28":"In den meisten F\u00e4llen handelt es sich im Kartenspiel der Mlle Lenormand bei dieser Karte um den Herzensmann der Fragestellerin, bzw um die Personenkarte, wenn der Fragesteller ein Mann ist.\n\nIm weiteren Verlauf des Buches wirst du allerdings feststellen, dass wir uns auch um die situativen Aspekte dieser Karte bem\u00fchen, sicher ist sicher. Wir haben uns ja mit dieser Lenormandreihe auf gemacht, super gr\u00fcndlich an die Komplexit\u00e4t dieses Spiels heran zu gehen, da werden wir in diesem Moment nicht z\u00f6gerlich sein.\n\nBeim Lenormand sind der Herr und die Dame als Personenkarten der Ausgangspunkt einer jeden Deutung. Wenn wir die gro\u00dfe Tafel auslegen, k\u00f6nnen wir schon auf den ersten Blick R\u00fcckschl\u00fcsse auf die Liebesbeziehung ziehen, wenn wir nur auf diese beiden Karten blicken.\n\nWir erkennen, was im Kopf des Fragestellers vor sich geht, welche Ereignisse sich in der j\u00fcngsten Vergangenheit zugetragen haben und welche Aspekte in der Zukunft eine wichtige Rolle spielen k\u00f6nnen.\n\nAnhand dieser Personenkarten erkennen wir nicht nur die oberfl\u00e4chlichen Fakten. Je intensiver wir uns mit den Lenormandkarten besch\u00e4ftigen, umso tiefer k\u00f6nnen wir in die Gef\u00fchls- und Erlebniswelten der Personen eintauchen.\n\nSehr interessant wird es, wenn wir die Person gerade erst kennen gelernt 28 haben und weiter noch \u00fcberhaupt keine Information von ihr haben.\n\nIch wei\u00df, vielleicht sollte es nicht so sein und vielleicht ist es auch nicht immer richtig, aber hey! Ich bin eine Frau und nichts tue ich lieber, als in den geheimen Gedanken und Gef\u00fchlen eines potentiellen Herzensmannes umher zu schn\u00fcffeln... Ist das typisch weiblich? Ich hoff. Und ich habe es wenigstens in dieser Hinsicht zur Perfektion gebracht, auch wenn ich nicht immer erfreut war \u00fcber das, was mir da entgegen kam...","29":"Die meiste Zeit ist dieses die Personenkarte f\u00fcr die Herzdame in diesem Spiel bzw f\u00fcr die weibliche Fragestellerin.\n\nAber auch hier m\u00f6chte ich die kleinen Aspekte dieser Karte nicht aussparen, die sie als Situation repr\u00e4sentiert und die uns oft ein gro\u00dfes Fragezeichen \u00fcber die Stirn schreiben, wenn es die Aussage zu wage oder einfach nur unsinnig macht.\n\nWie bei der Karte 28 Der Herr, k\u00f6nnen wir beim Auslegen der gro\u00dfen Tafel genau erkennen, wie und in welcher Beziehung die Herzenspartner zueinander stehen und wie es sich in naher Zukunft entwickeln wird.\n\nWir k\u00f6nnen also genau betrachten, in welchem Bezug wir zu unserem Herzensmann stehen und wir sehen auch das, was sich im Schatten verbirgt, was uns unbewusst bleibt und was wir bisher noch nicht in Betracht gezogen haben.\n\nWenn wir also in die Lenormandkarten einsteigen und uns ansehen, wie wir in Bezug auf eine eventuelle Partnerschaft da stehen, dann sehen wir auch, sollte es Probleme geben, wo genau die Ursachen daf\u00fcr zu finden sind und wie wir sie aus der Welt schaffen k\u00f6nnen.\n\nUnd wenn dann diese Karte als Beschreibung einer bestimmten Situation betrachtet werden soll, dann sagt sie uns, dass es hier um den passiven Teil unserer Pers\u00f6nlichkeit geht, dass wir vielleicht sogar fremd bestimmt sind, zu introvertiert, in jedem Fall aber den empfangenden Aspekt dieser Karte nicht 29 au\u00dfer Acht lassen sollten.","31":"Nahrung\n\nAls Leben spendende Quelle der Energie f\u00f6rdert die Sonne unsere Kreativit\u00e4t und setzt in uns sch\u00f6pferische Kr\u00e4fte frei.\n\nDie Sonne ist mehr als nur das Kraftwerk unseres Sonnensystems. Sie ist der Quell des Lebens, des Lichts und der W\u00e4rme. Sie durchflutet uns mit Gl\u00fcck und Energie. Somit ist sie eine ausgesprochene Gl\u00fcckskarte, die h\u00f6chste Karte im Lenormand.\n\nSo steht die Sonne Kartenspiel der Mlle Lenormand unter anderem f\u00fcr Licht, W\u00e4rme und Gl\u00fcck. Und wer sie neben der eigenen Personenkarte findet, der kann sich sehr gl\u00fccklich sch\u00e4tzen.\n\nDie Sonne symbolisiert nicht nur die g\u00f6ttliche Sch\u00f6pfungskraft, sondern auch das h\u00f6chste Bewusstsein. Sie steht f\u00fcr Klarheit und das v\u00f6llige Fehlen von Schatten und Finsternis.\n\nDennoch kann das Licht ohne seinen finsteren Gegenpol, den Schatten, nicht existieren. Sie setzt sich durch gegen alles Dunkle und wird immer siegen. So steht die Sonne auch f\u00fcr die Erf\u00fcllung unserer W\u00fcnsche und Bildung (Wahrheit). Die Sonne macht uns wach, klar und verstehend.\n\nDie einzige halbwegs negative Deutung der Sonne hat nur dann eine Relevanz, wenn sie in keiner direkten Beziehung zur Personenkarte steht, am weitesten von ihr entfernt ist oder durch wirklich negative Karten blockiert ist.\n\nDa die Sonne eine sehr hoch energetische und kraftvolle Karte des Gl\u00fccks ist, sollte ihre Lage bei jeder Deutung mit den Lenormandkarten besonders viel Aufmerksamkeit geschenkt werden. 31","32":"Im Kartenspiel der Mlle Lenormand steht der Mond nicht wie im Tarot oder in erster Lilie f\u00fcr den Spiegel der Seele, sondern will das Rampenlicht ausdr\u00fccken, in das wir gestellt werden k\u00f6nnen oder m\u00f6chten.\n\nVielleicht erinnerst du dich noch an die Sendung Disco, aus den 70iger Jahren, mit Ilja Richter: \"Licht aus! Whommm! - Spott an!\" Und im Scheinwerferlicht erschien eine Person, die f\u00fcr einen Moment im Rampenlicht stand.\n\nUnd wenn wir es recht bedenken, so sah dieses Rampenlicht genau so aus, wie ein voller Mond.\n\nNat\u00fcrlich bezieht sich der Mond im Lenormand auch auf unser Innenleben, auf Intuition und all das. Dennoch sollten wir bei DIESEM Mond im Auge behalten, dass es sich um das Lenormand handelt und somit viel n\u00e4her am Allt\u00e4glichen gelagert ist als jedes andere Orakel.\n\nWas ist es denn, was wir uns am meisten w\u00fcnschen auf dieser Erde? Liebe und Anerkennung! Neben der Nahrung und dem sicheren Schlafplatz sind Liebe und Anerkennung die Dinge, f\u00fcr die wir Menschen bereit sind zu t\u00f6ten!\n\nWenn wir den Mond im Lenormand betrachten, dann sollten wir das immer im Hinterkopf behalten: Liebe und Anerkennung. Der Mond k\u00fcndet sie an. Er zeigt, wenn er in gerader Linie (in bekannter Form waagerecht, senkrecht, diagonal oder im R\u00f6sseln) zur Personenkarte liegt, dass Liebe und Anerkennung nicht mehr weit sind, vielleicht schon sehns\u00fcchtig erwartet und auch aus welcher Richtung sie kommen.\n\nDa der Mond auch eine Karte der Zyklen ist, kann durch sie auch ein wiederkehrendes Ereignis angedeutet werden. Hier kommt es darauf an, die Intuition und die Erfahrung richtig einzusetzen. Eine Tabelle mit dem Biorhythmus kann da sehr aufschlussreich sein.","33":"Der Schl\u00fcssel im Kartenspiel der Mlle Lenormand steht f\u00fcr all die Dinge, die sich uns jetzt im wahrsten Wortsinne erschlie\u00dfen.\n\nMit einem Schl\u00fcssel in der Hand bekommen wir sicheren Zugang zu den Bereichen, die wir zuvor nicht betreten konnten. Der Schl\u00fcssel macht die Sache leicht.\n\nSo steht der Schl\u00fcssel f\u00fcr einen Neubeginn, da wir einen Raum betreten, der zuvor verschlossen war, er steht f\u00fcr Erfolg, da sich die T\u00fcr leicht \u00f6ffnet, wenn es der richtige Schl\u00fcssel ist, den wir ins Schloss stecken.\n\nEr ist ein Werkzeug zum \u00d6ffnen eines Schlosses. Es ist eine sehr alte und heute noch sehr oft genutzte Methode des Einbruchschutzes und der Zutrittskontrolle. Mit einem Generalschl\u00fcssel k\u00f6nnen mehrere Schl\u00f6sser entsperrt werden und der berechtigte Nutzer eines Schl\u00fcssels hat somit die Schl\u00fcsselgewalt inne.\n\nDas alles sind auch die Qualit\u00e4ten dieser Karte und je nach ihrer Lage k\u00f6nnen wir erkennen, ob es sich sogar um einen Generalschl\u00fcssel handelt. In jedem Falle zeigen die umliegenden Karten, was sich uns mit dem Schl\u00fcssel erschlie\u00dft.\n\nSchl\u00fcssel und Schl\u00f6sser wurden bereits im alten \u00c4gypten benutzt. Sie bestanden anfangs aus Holz und sp\u00e4ter, wie heute fast ausschlie\u00dflich, aus Metall. Sie wurden benutzt, um private und sch\u00fctzenswerte R\u00e4ume oder Truhen vor unbefugten Betreten oder \u00d6ffnen zu sch\u00fctzen.\n\nMit einem Schl\u00fcssel haben wir die Sicherheit, dass nur wir diesen besonderen Bereich betreten d\u00fcrfen.\n\nSo erf\u00fcllt er uns zum einen die Funktion uns Zugang zu einem Ort oder Gebiet zu verschaffen und zum anderen erlaubt er uns auch, diesen Zugang 33 anderen abzuschneiden, indem wir unser Haus, ein Auto, ein Fahrrad oder ein Schmuckk\u00e4stchen abschlie\u00dfen und somit den Inhalt sch\u00fctzen.","34":"Die Fische repr\u00e4sentieren Reichtum, Verm\u00f6gen und Wohlstand. Wer schon einmal gesehen hat, wie die gro\u00dfen, senffarbenen Koikarpfen gehandelt werden (sie haben mitunter Preise, f\u00fcr die man gut und gern ein Einfamilienhaus bek\u00e4me), kann sich vorstellen, warum im Lenormand die Fische f\u00fcr diese Aufgabe ausgew\u00e4hlt wurden.\n\nMan sagt, das dem, der in der Nacht im Traum einen Fisch angelt, alsbald ein gro\u00dfer Gewinn zuf\u00e4llt. So geben die Fischen in den Karten der Mlle Lenormand zumeist Hinweis auf die Finanzen und Geldangelegenheiten des Fragestellers.\n\nAber das ist noch nicht alles, es gibt mehr darin zu entdecken, selbst in Situationen, in denen es nicht explizit um die Finanzen geht.\n\nDenn um Fische fangen zu k\u00f6nnen, muss man einiges an Vorarbeit leisten. Man braucht gutes Angelger\u00e4t und K\u00f6der, vielleicht ein Netz oder sogar ein Boot. Und der Fisch ist somit die Belohnung f\u00fcr diese M\u00fche, die Ernte, die eingebracht wird.\n\nSo bezieht sich diese Karte in den meisten F\u00e4llen auf Geld oder auf Gesch\u00e4ftsideen, Anlageformen, neue Auftr\u00e4ge oder Sonderzahlungen.\n\nIn einigen F\u00e4llen sind die Fische auch ein Symbol f\u00fcr die Dinge, die wir gerne haben wollen, die wir uns von tiefstem Herzen w\u00fcnschen, erhoffen oder herbeisehnen. So dringen die Fische tief ein in unser Seelenleben, wie sie in den Meerestiefen herum schwimmen. Eine Welt, die f\u00fcr uns Menschen nicht bewohnbar ist.\n\nWegen seiner zahlreichen Vermehrung ist der Fische in vielen Kulturen ein Symbol der Fruchtbarkeit. So k\u00f6nnen wir neben dem finanziellen Aspekt, den der Fisch verk\u00f6rpert, an ihm auch erkennen, was in unserem Leben mehr wird.","35":"Der Anker im Kartenspiel der Mlle Lenormand symbolisiert zumeist berufliche Aspekte und wozu wir uns berufen f\u00fchlen. Wir finden den Anker an einem Schiff im Hafen und es macht Arbeit, ihn zu lichten oder zu Wasser zu lassen.\n\nDer Anker ist ein schweres, an einer Kette oder einem Tau h\u00e4ngendes Ger\u00e4t, das vom Schiff aus auf den Boden eines Gew\u00e4ssers hinab gelassen wird, wo es sich selbstst\u00e4ndig in den Grund eingr\u00e4bt und dadurch das Schiff an seinem Platz h\u00e4lt.\n\nDamit haben wir auch schon den zweiten Aspekt des Ankers gefunden: Er steht eben auch f\u00fcr Dinge, die an uns h\u00e4ngen, die wir nicht loslassen k\u00f6nnen oder schlimmer noch, die UNS nicht loslassen.\n\nSo weist der Anker mit seiner klaren Aufgabe aus der Seefahrt ganz allgemein auf unsere Verankerung hin, das hei\u00dft auf die Frage, woher wir unseren Halt beziehen, unsere Verankerung, sprich unsere Identit\u00e4t- unseren Heimathafen.\n\nDer Bezug zur Tiefe erscheint hier besonders wichtig, denn der Anker erm\u00f6glicht eine Befestigung und Sicherung nach unten hin, im \u00fcbertragenen Sinne in den Tiefen unserer eigenen Seele.\n\nDaher k\u00f6nnen wir in seiner N\u00e4he erkennen, was unsere Berufung in diesem Leben ist, warum wir hier sind und wohin wir gehen wollen.\n\nIm Bereich des t\u00e4glichen Lebens behandelt der Anker also alle Dinge, die mit dem Beruf, mit der beruflichen Orientierung, mit der fachlichen Qualifikation und mit unserer Arbeit zu tun haben.\n\nHier erkennen wir, ob wir eine neue Arbeitsstelle bekommen oder das Betriebsklima wieder besser wird und alle anderen wichtigen Dinge, die mit der Arbeit und dem Beruf in Verbindung stehen.","36":"Das Kreuz in den Lenormandkarten ist immer ein Hinweis auf bedeutungsvolle Ereignisse, auf das Schicksal, auf Bestimmung, eine Pr\u00fcfung vielleicht und auf Herausforderungen.\n\nDabei muss seine Bedeutung nicht immer im negativen Sinne gemeint sein. Ein schicksalhafter Aspekt behandelt immer ein Thema im Leben des Fragestellers, dass eine entscheidende Bedeutung eingenommen hat oder einnehmen wird.\n\nWir haben hier die M\u00f6glichkeit der Unterscheidung: Wenn wir uns dazu entschlie\u00dfen, k\u00f6nnen wir alle Karten, die links vom Kreuz liegen als die Aspekte betrachten, die an Bedeutung verlieren oder verloren gehen.\n\nDie Karten, die rechts vom Kreuz zu liegen kommen, werden in ihrer Bedeutung zunehmen und schwerer wiegen im Laufe der Zeit.\n\nWenn also der Fragesteller seinen Weg genau so weiter geht im Leben, wie er ihn zu diesem Zeitpunkt eingeschlagen hat, und es liegt das Kreuz in einer direkten Verbindung in der Zukunft, dann kann man hier genau erkennen, welchen Schwierigkeitsgrad die vor ihm stehende Situation einnimmt.\n\nDas Kreuz ist ein Repr\u00e4sentant einer besonders schicksalhaften Lebenssituation, die durchaus auch besonders positiv sein kann.\n\nWeiterhin steht das Kreuz f\u00fcr den Glauben des Fragestellers, nicht ausschlie\u00dflich auf den religi\u00f6sen Bereich reduziert. Es umfasst die gesamte Wahrnehmung unserer materiellen Welt, die (mehr oder weniger behindernden) Glaubenss\u00e4tze, vielleicht auch Illusionen und Verzerrungen.\n\nWenn diese Karte in einer direkten Verbindung (horizontal, vertikal, diagonal oder im R\u00f6sseln) zum Fragesteller auftaucht, dann ist sie auf jeden Fall mit besonderer Aufmerksamkeit zu studieren.","6":"In meiner Welt ist diese Karte ebenso ambivalent, wie die Schlange, die Ruten und der Fuchs. Wenn diese Karten auftauchen, beschleicht einen meist ein ungutes Gef\u00fchl in der Magengegend, wobei nicht immer der negative Aspekt dieser Karte ausgedr\u00fcckt werden will.\n\nSo k\u00f6nnen auch Wolken durchaus hell und klar sein. Aber sind wir mal ehrlich: Wenn das Wetter sch\u00f6n ist, bedarf es dann einer besonderen Erw\u00e4hnung? Reden wir nicht bedeutend h\u00e4ufiger \u00fcber das Wetter, wenn es zu kalt, zu grau, zu regnerisch oder zu st\u00fcrmisch ist? Und manchmal ist es sogar zu sch\u00f6n um wahr zu sein? Genau das.\n\nEs lohnt sich, gedanklich eine Linie von der eigenen Personenkarte durch die dunklen Wolken zu ziehen und der Karte dahinter besondere Aufmerksamkeit zu schenken. Das ist unser \"blinder Fleck\", dort finden wir Dinge oder Angelegenheiten, f\u00fcr die wir im wahrsten Wortsinne betriebsblind geworden sind.\n\nDurchschauen k\u00f6nnen wir einen Aspekt in der unsichtbaren Welt unserer Gedanken und Energien immer dann, wenn wir die Fragen direkt stellen: Wer oder was bist du? Was m\u00f6chtest du, dass ich tue? Wie soll ich mich deiner Meinung nach verhalten, jetzt?\n\nIndem wir uns auf den verborgenen Aspekt eines Themas konzentrieren, wird uns das, was noch verschleiert ist, allm\u00e4hlich klar ins Bewusstsein gelangen.\n\nWir gewinnen auf diese Art auch Hinweise darauf, ob wir einen gewissen Aspekt einer Situation nicht erfassen k\u00f6nnen, weil andere Menschen uns bewusst oder unbewusst von unserem Weg ablenken, vielleicht sogar wissentlich wichtige Fakten vor uns verbergen wollen, oder sie wollen ein Geheimnis f\u00fcr sich behalten.","7":"Die Schlange an sich ist in der Geschichte der Menschheit ein mythisches Symbol mit viel Tiefe. Sie hing vom Baum des Wissens im Paradies und verf\u00fchrte Eva dazu, von der verbotenen Frucht zu kosten, worauf Eva schamhaft wurde und ihre Bl\u00f6\u00dfe entdeckte.\n\nCleopatra legte eine Schlange an ihre Brust, um sich mit Hilfe ihres Giftes zu entleiben. So spielt die Schlange immer auch eine ambivalente Rolle. Als gro\u00dfartige Frau und charismatische Pers\u00f6nlichkeit verbinden wir Cleopatra mit der starken Frau, die wei\u00df, was sie will und das auch erreicht und wenn nicht, ihre Konsequenzen daraus zieht. So verbinden wir die Schlange auf diese Weise auch mit der taffen Frau, der Schwiegermutter oder der besten Freundin.\n\nNicht umsonst sagt man: Die Dosis macht das Gift. Und so kann Schlangengift t\u00f6ten oder als Medizin gegen Rheuma eingesetzt werden.\n\nDie Schlange kann mit ihrem schlanken K\u00f6rper die verschlungensten Pfade aufsuchen oder das Ge\u00e4st von B\u00fcschen und B\u00e4umen v\u00f6llig ger\u00e4uschlos durchqueren. So steht diese Karte auch f\u00fcr die verschlungenen Wege und die Umwege, die wir im wirklichen Leben gehen m\u00fcssen.\n\nSie ist ein giftiges Reptil, welches aus dem Hinterhalt mit einem Biss die Beute in Sekundenschnelle t\u00f6ten kann. Andererseits hat ihr Gift eben auch eine gewisse Heilwirkung, weshalb sie auch das Symbol der Heiler ist und im \u00c4skulapstab abgebildet wird. Wir sehen ihn oft an Apotheken.\n\nSo kann die Schlange im Kartenspiel der Mlle Lenormand mit ihrem Gift eine Situation auf die ein oder andere Art und Weise beeinflussen, heilsam oder t\u00f6dlich sein.\n\nManchmal deutet sie aber auch auf eine Person, auf eine besondere Frau hinweisen. Eine Busenfreundin vielleicht, eine Schwiegermutter, oder die \"falsche\" Liebe, also die Geliebte repr\u00e4sentieren.","8":"Schauen wir uns diese Karte also unter dem Aspekt der Ruhest\u00e4tte genauer an. Ja, es mag uns schwer erscheinen und diese Karte mag auch einen riesigen Schatten werfen. Aber lebt nicht gerade das Kartenlegen von dem, was betrachtet wird, wo keiner mehr hinsehen mag?\n\nNat\u00fcrlich ist das was in dem Sarg drinnen liegt tot. Warum sollte es sonst im Sarg liegen. Dem zur Folge kann diese Karte in Kombination mit anderen Karten auch den physischen Tod vorhersagen. Das aber ist auch immer eine ethische Frage und geh\u00f6rt so hier nicht hin.\n\nDennoch sollten wir uns ansehen, auf welche Situation uns der Sarg hinweisen m\u00f6chte: Lieber ein Ende mit Schrecken, als ein Schrecken ohne Ende.\n\nUnd so will uns der Sarg mit seiner d\u00fcsteren Energie einen geh\u00f6rigen Schrecken einjagen, um uns wach zu r\u00fctteln, um uns zu zeigen, wof\u00fcr wir unsere Energie verschwenden, um uns eine Wahl zu lassen, ob wir wirklich weiter hinter unserem Wunsch herlaufen wollen, wie ein Esel, dem man eine M\u00f6hre vor die Nase gebunden hat...\n\nWenn wir in dieser Situation verharren, sind wir wie jemand, der dem Lauf des Lebens Einhalt gebieten will, mit allen ihm zur Verf\u00fcgung stehenden Mitteln. Wir wollen nicht loslassen, was schon lange gestorben ist.\n\nTrauern ist wichtig. Loslassen auch, und so erf\u00fcllt uns der Sarg auch oft unsere schlimmsten Bef\u00fcrchtungen.","9":"Blumen verschenken wir nie ohne Grund. Vielleicht wollen wir Aufmerksamkeit schenken und Sympathie erlangen, vielleicht auch um Entschuldigung bitten, in jedem Falle wollen wir aber jemandem Besonderen eine Freude bereiten.\n\nOft werden die Blumen wegen ihrer positiven und frischen Ausstrahlung auch mit einer jungen Dame assoziiert. Insgesamt stellen die Blumen im Kartenspiel der Mlle Lenormand eine Gl\u00fcckskarte dar.\n\nSie sind ein positiver Ausdruck von W\u00e4rme und immer ein willkommenes Geschenk. In den meisten F\u00e4llen ist es so.\n\nBlumen sind im Vergleich zu Schmuck aus Gold uns Silber nicht besonders teuer und sie sind einfach nur ein Beweis daf\u00fcr, dass wir jemandem etwas bedeuten und nicht unwichtig sind.\n\nUm welche Art Geschenk es sich handelt, wenn die Karte der Blumen in unserer Auslegung auftaucht, erkennen wir aus den umliegenden Karten.\n\nEs kann sich dabei um wirkliche Blumen handeln, aber auch um die Wiederkehr von Freude im Leben, um unverhofftes Gl\u00fcck oder einladende Angebote. Ein Kasten Konfekt oder ein Kompliment von unerwarteter Stelle. Man f\u00fchlt sich geliebt und geachtet, wenn man Blumen geschenkt bekommt.\n\nDie Energie der Karte der Blumen repr\u00e4sentiert die also eine positive Energie, die die Kraft hat, alle dunklen Karten um sie her aufzuhellen und positiv zu beeinflussen. In manchen F\u00e4llen meint sie auch ein junges M\u00e4dchen.","12":"Manchmal werden die V\u00f6gel auch mit der Zahl zwei in Verbindung gebracht oder mit gefl\u00fcgelten Wesen aus der geistigen Welt, mit Engeln, Feen und Elfen.\n\nV\u00f6gel sind zwar in der Luft vor Fressfeinden, wie Katzen, F\u00fcchsen oder Mardern relativ sicher, am Boden jedoch wehrlos, schwach und zerbrechlich.\n\nKein Wunder also, dass die V\u00f6gel sehr scheu sind und bei jeder kleinen Bewegung hektisch in die Luft gehen. Das Bild, das uns die Karte der V\u00f6gel im Spiel der Mlle Lenormand vermitteln will, ist eben dieser Moment des auf und davon Fliegens.\n\nAlle V\u00f6gel fliegen erschreckt los und suchen das Weite, nur um wenige Augenblicke sp\u00e4ter zur Futterstelle zur\u00fcckzukehren, immer dann, wenn sich die Gefahr als grundlos heraus gestellt hat.\n\nBei den V\u00f6geln geht es um eine kleine, hektische Aufregung im Alltag. Dabei handelt es sich nicht gerade um die gro\u00dfe Umw\u00e4lzungen oder gravierende Ver\u00e4nderungen im Leben, sondern um Dinge, die uns erschrecken, \u00e4rgern, auf den Geist gehen oder nerv\u00f6s machen.\n\nHier handelt es sich um die allt\u00e4glichen Dinge, die im Augenblick alle Aufmerksamkeit an sich ziehen, aber in wenigen Tagen schon wieder in Vergessenheit geraten sein werden, so viel ist sicher.\n\nEs kann sich auch um kurze Ereignisse handeln: ein Treffen zum Beispiel, ein Blinddate, ein Liebesflirt oder um eine \u00fcberraschende Nachricht aus dem Bekanntenkreis.","30":"Die Lilie steht im Kartenspiel der Mlle Lenormand f\u00fcr Freundschaft und auch f\u00fcr die Sexualit\u00e4t. Sie zeigt ebenso oft auf einen G\u00f6nner und F\u00f6rderer, wie auch auf einen heimlichen Geliebten.\n\nDie Lilie an sich sieht nicht nur sch\u00f6n aus und gibt damit Hinweise auf Sch\u00f6nheit und Eleganz, sie gilt auch als Heilpflanze und schlie\u00dft damit den Bezugsrahmen zur Unterst\u00fctzung, die man auch im famili\u00e4ren Kreise finden kann.\n\nIn vielen religi\u00f6sen Zeremonien und in den Wappen vieler Ritter und Adliger finden wir die Lilie wieder. Meist in Form der franz\u00f6sischen Lilie.\n\nSo symbolisiert sie in der christlichen Kultur die Reinheit und die Jungfr\u00e4ulichkeit und oft wird die Lilie mit der heiligen Mutter Gottes, der Jungfrau Maria, in Verbindung gebracht.\n\nBei den Griechen ist die Lilie die Blume der G\u00f6ttin Hera und der Legende nach hat die G\u00f6ttin Aphrodite der unschuldigen Lilie ihren phallusartigen Stempel hinzugef\u00fcgt, was den sexuellen Aspekt dieser Karte kennzeichnet.\n\nIm Lenormand steht die Lilie f\u00fcr Freundschaft und Harmonie, vielleicht auch durch Freundschaft Plus und f\u00fcr die Harmonie die entsteht, wenn man guten Sex gehabt hat und so hat die Lilie f\u00fcr eine Deutung mit Blick auf eine bestehende Partnerschaft innerhalb ihrer Kombinationen in der Lenormand- Matrix eine besondere Bedeutung. Dicht neben einer Personenkarte hat die Lilie h\u00e4ufig einen Bezug zur Sexualit\u00e4t. Wir sollten allerdings darauf achten, ob die Lilie wirklich eine direkte Verbindung zu einer Personenkarte hat (in einer Linie horizontal, vertikal, diagonal oder im R\u00f6sseln zum Beispiel), da sie ansonsten leicht fehlinterpretiert werden kann und zu falschen Schl\u00fcssen verf\u00fchrt."};

const CLUSTERS={"3er":[{karten:[7,13,17],label:"Schwangerschaft · Klassiker",text:"Der absolute Schwangerschafts-Klassiker. Lilien steht für Familie und Reife, Kind für Neuanfang, Störche für Veränderung und neue Ankunft."},{karten:[4,17,36],label:"Familiäres Schicksal",text:"Eine Veränderung im Familienleben, die bestimmt war. Das Kreuz gibt Gewicht — kein Zufall, das ist Bestimmung."},{karten:[13,31,17],label:"Freudige Ankunft",text:"Neues Leben das mit Freude und Licht kommt. Kein Zweifel, keine Wolken — das ist eine frohe Botschaft."},{karten:[5,13,30],label:"Gesunde Entwicklung",text:"Langsames, gesundes Wachstum. Geduld wird belohnt."},{karten:[20,36,25],label:"Hochzeit · Klassiker",text:"Die klassische Hochzeit im Lenormand. Öffentliche Feier (Park), schicksalhafter Bund (Kreuz), Verbindung fürs Leben (Ring)."},{karten:[24,25,31],label:"Glückliche Verbindung",text:"Liebe, Bindung, Erfolg — eine Verbindung die aus echten Gefühlen entsteht und glücklich wird. Das Herz hat gewählt."},{karten:[25,33,36],label:"Schicksalsbindung",text:"Diese Verbindung war vorherbestimmt. Schlüssel macht es sicher, Kreuz gibt ihm Schicksal."},{karten:[10,25,24],label:"Trennungsschnitt",text:"Die Sense schneidet durch Ring und Herz — eine Beziehung endet abrupt. Ein klarer Schnitt."},{karten:[21,25,23],label:"Schleichende Erosion",text:"Hindernisse und Verlust umgeben die Bindung. Kein plötzliches Ende — ein langsames Bröckeln."},{karten:[6,24,8],label:"Ende im Unklaren",text:"Eine Beziehung stirbt in Unklarheit. Was war, ist vorbei — auch wenn man es noch nicht glauben will."},{karten:[24,33,16],label:"Herzenswunsch erfüllt",text:"Der Herzenswunsch erfüllt sich mit Sicherheit. Wer auf Liebe hofft und diese drei zieht, darf aufatmen."},{karten:[18,24,25],label:"Treue Partnerschaft",text:"Auf echter Freundschaft und Treue gebaut. Diese Beziehung hält, weil sie auf festem Boden steht."},{karten:[32,24,16],label:"Tiefe Seelenbegegnung",text:"Diese Verbindung geht tiefer als die Oberfläche. Manchmal die Liebe des Lebens."},{karten:[5,8,23],label:"Gesundheitswarnung",text:"Ein ernstes Signal. Wenn Sarg und Mäuse neben dem Baum liegen, nagt etwas an der Gesundheit. Ein Arztbesuch wäre klug."},{karten:[5,31,33],label:"Heilung mit Sicherheit",text:"Die Gesundheit erholt sich — und zwar mit Sicherheit."},{karten:[6,32,8],label:"Psychische Belastung",text:"Unklarheiten, emotionale Erschöpfung und ein Ende. Eine psychische Krise — Hilfe holen ist keine Schwäche."},{karten:[10,6,8],label:"Unfall oder Schock",text:"Plötzlich, unerwartet, mit Konsequenzen. Ein Ereignis das niemand kommen sah."},{karten:[8,36,5],label:"Chronische Erkrankung",text:"Eine Krankheit die bleibt — die zum Schicksal gehört. Nicht Ende, sondern Transformation."},{karten:[14,7,23],label:"Doppelte Gefahr",text:"Hinterlist und Konkurrenz nagen gemeinsam. Hier ist Vorsicht dringend angebracht."},{karten:[6,14,27],label:"Täuschende Nachricht",text:"Eine Nachricht ist nicht das was sie scheint. Nicht unterschreiben, nicht glauben — erst prüfen."},{karten:[19,14,26],label:"Institutioneller Betrug",text:"Eine Behörde oder Institution verbirgt etwas. Das Geheimnis liegt hinter verschlossenen Türen."},{karten:[10,19,36],label:"Schicksalsschlag",text:"Ein plötzlicher, gravierender Einschnitt. Das Kreuz macht ihn unvermeidlich."},{karten:[34,31,33],label:"Finanzieller Durchbruch",text:"Geld kommt — sicher und mit Glanz. Das große Ja für alle Finanzfragen."},{karten:[34,23,8],label:"Finanzieller Verlust",text:"Geld schwindet — und zwar nicht wenig. Das Ende einer finanziellen Situation ist nah."},{karten:[34,15,35],label:"Stabiler Wohlstand",text:"Geld, Kraft und Beständigkeit — das ist nachhaltiger finanzieller Aufbau."},{karten:[3,34,16],label:"Erbschaft oder Auslandsgeld",text:"Geld kommt von weit her — Erbschaft, Auslandszahlung oder Geschäft über Grenzen."},{karten:[35,33,31],label:"Sicherer Berufserfolg",text:"Beruflicher Erfolg der mit Sicherheit eintritt. Beförderung, Festanstellung, Vertrag."},{karten:[14,35,23],label:"Jobverlust durch Intrigen",text:"Am Arbeitsplatz arbeitet jemand gegen die fragende Person. Mobbing oder Intrigen möglich."},{karten:[16,3,35],label:"Traumjob im Ausland",text:"Ein lang gehegter Berufswunsch erfüllt sich — möglicherweise in der Ferne."},{karten:[4,31,33],label:"Eigenes Heim",text:"Der Traum vom eigenen Heim wird wahr — sicher und mit Freude."},{karten:[3,33,16],label:"Traumreise",text:"Eine Reise die sich erfüllt — sicher und wunschgemäß."},{karten:[17,3,4],label:"Umzug",text:"Ein Wohnortwechsel steht an. Störche bringen Veränderung, Schiff den Transport, Haus den neuen Hafen."},{karten:[36,33,32],label:"Karmische Erkenntnis",text:"Eine Situation die Schicksal ist — und durch die etwas Tiefes erkannt wird. Wer das versteht, wächst daran."},{karten:[16,32,33],label:"Spiritueller Durchbruch",text:"Wünsche, Intuition und Gewissheit — ein Moment tiefer innerer Klarheit."},{karten:[7,5,32],label:"Heilerin",text:"Die Schlange als Gift und Heilmittel, Baum als Gesundheit, Mond als Seele — das Bild der Heilerin."},{karten:[31,33,16],label:"Volltreffer",text:"Die drei stärksten positiven Karten zusammen. Was auch immer gefragt wurde — Ja, sicher, und besser als erhofft."},{karten:[32,31,16],label:"Volle Strahlkraft",text:"Innen und außen leuchten gleichzeitig. Ruhm, Anerkennung, Selbstverwirklichung."}],"4er":[{karten:[20,25,36,31],label:"Hochzeit mit Segen",text:"Öffentliche Feier, Verbindung, Schicksal und Licht — eine Hochzeit die gesegnet ist."},{karten:[30,13,17,31],label:"Erwünschte Schwangerschaft",text:"Der Klassiker mit Licht — eine Schwangerschaft die erwartet wurde und mit Freude kommt."},{karten:[14,7,23,6],label:"Komplexe Intrige",text:"Vier Karten in dieselbe Richtung. Etwas wird verborgen, mehrere Kräfte arbeiten dagegen. Hier stimmt etwas fundamental nicht."},{karten:[21,8,23,36],label:"Schicksalhafte Krise",text:"Eine Phase die unvermeidlich ist und tief geht. Das Kreuz macht es zum Schicksal. Aber Stürme hören auch auf."},{karten:[31,33,16,34],label:"Materieller & spiritueller Erfolg",text:"Das volle Paket: Licht, Sicherheit, Träume und Geld. Selten — aber wenn es passiert: glauben."},{karten:[32,31,33,36],label:"Lebensaufgabe gefunden",text:"Innen und außen, Gewissheit und Schicksal — jemand hat seinen Weg gefunden und weiß wohin er geht."},{karten:[35,34,31,33],label:"Finanzielle Unabhängigkeit",text:"Berufliche Stabilität, Geld, Licht und Gewissheit — das Bild von jemandem der auf eigenen Beinen steht."}]};

const TIME_QUIZ={"1":"Sehr schnell, ohne weitere Zeitverzögerung","2":"In 2–3 Tagen","3":"In einigen Monaten; bis zu einem Jahr","4":"Am Abend, in der Nacht, am Ende des Jahres oder auch im Winter","5":"Es dauert noch 9–12 Monate","6":"Wenn du nach der Zeit fragst, dann kann es darüber wieder Herbst werden","7":"Das kann sich noch ein halbes Jahr so dahin schlängeln","8":"Nur eben momentan tut sich grad mal nichts","9":"Im Frühling","10":"Es geschieht sehr plötzlich","11":"Und weil du diese Auseinandersetzung scheust, dauert es doppelt so lange, als es dauern müßte","12":"im Oktober","13":"Zeit: sehr bald","14":"nachts, im Dezember","15":"Wann: Im Winter.","16":"Wann: abends, nachts, im Winter.","17":"Im Februar oder August","18":"Im Juli und dann für eine lange Zeit","19":"In einem Tag, einer Woche, einem Monat oder einem Jahr","20":"Wann: 3 Wochen - 3 Monate.","21":"Wann: im Januar.","22":"Wann: innerhalb von 2 Monaten.","23":"Es verzoegert sich noch eine ganze Weile","24":"Wann: im August.","25":"Es wird noch eine Weile dauern, man dreht sich im Kreis","26":"Auch das Wann ist noch verborgen","27":"Wann: in wenigen Tagen.","28":"Wann: am Nachmittag, im Herbst.","29":"Wann: im Mai.","30":"Wann: im Winter","31":"Bei kurzfristigen Dingen zur Mittagsstunde, ansonsten im Sommer","32":"In 4 Wochen (28 Tage)","33":"Wann: Es ist an der Zeit, sich jetzt zu oeffnen. In jedem anderen Fall: im November.","34":"Wann: im Februar.","35":"Wann: im September.","36":"Wann: 2-3 Wochen"};

const PERSON_SIG={"1":"Ein junger Mann, mehr seinen Aufgaben verpflichtet, als großen Worten; sehr ritterlich.","2":"Dieser Mensch ist ein unverbesserlicher Optimist, etwas oberflächlich vielleicht, aber sehr bezaubernd.","3":"Ein Mensch mit fremdländischem Aussehen, ein Ausländer vielleicht; er philosophiert gern und ist lern- und wissbegierig","4":"Dieser Mensch ist sehr gradlinig und leicht zu berechnen, etwas bequem aber sehr gemütlich.","5":"Ein Mensch, der sich gern in der Natur bewegt, geduldig sein kann und ausdauernd; mit Sinn für die Familie und ein gesundes Leben.","6":"Dieser Mensch gibt sich nicht so leicht zu erkennen. Achte auf Kleinigkeiten.","7":"ältere Frau, Freundin, Tochter, Mutter, Schwester, Rivalin, Geliebte","8":"Person mit magischer Anziehungskraft, eventuell mit durchdringendem Blick.","9":"Diese Person ist eine gepflegte Erscheinung.","10":"Diese Person ist eher zurückhaltend und unauffällig; aber das ist meist nur Tarnung. Das wahre Wesen dieses Menschen offenbart sich erst in der Tiefe und das kann plötzlich geschehen und uns sehr überraschen.","11":"Diese Person redet nicht ohne bedacht. Sie weiß um die Wirkung von Worten und wie sie diese für ihre Ziele einsetzen kann.","12":"Tratschtanten, vielleicht auch Oma und Opa","13":"Ein Mensch der sehr vertrauensseelig ist, vielleicht sogar etwas naiv erscheint, aber dennoch erfrischend unverdorben, herzlich und spontan.","14":"Diesem Menschen sind Dynamik, Herausforderung und Abwechslung wichtig. Er geht gern aufs Ganze, koste es was es wolle.","15":"Niemand kann so arbeiten wie ein Bär, allerdings nur, wenn er von seinem tun absolut überzeugt ist und wenn es ihn auf seinem Weg zum Ziel weiter bringt.","16":"Dieser Mensch liebt schöne Dinge mit viel Ästetik, ist kreativ und verfügt über ein hohes, schöpferisches Potential.","17":"Dieser Mensch ist auf seine bezaubernde Art sehr liebenswert, wenngleich auch etwas verschroben.","18":"Dieser Mensch ist ein Freund, man kennt ihn schon und sieht ihn, meist auf eine eher unerotische Art.","19":"Dieser Mensch erscheint etwas schwierig im Umgang zu sein, ob seiner Unbeugsamkeit und Beharrlichkeit. Aber hinter der rauen Schale steckt ein sanfter Kern.","20":"Dieser Mensch hat es nicht leicht, sich zu behaupten, da er von der Aufmerksamkeit seiner Umwelt lebt. Das kann mitunter anstrengend sein.","21":"Dieser Mensch ist eher unaufgeregt, gradlinig und man könnte ihn mitunter als starrsinnig bezeichnen. Seine Verlässlichkeit und Ausdauer gleichen dies vorzüglich aus.","22":"Eine energievolle Frau, die sehr begeisterungsfähig ist und selbstbewußt.","23":"Dies ist ein Mensch, dem ständig etwas fehlt oder verloren geht. Es fehlt ihm an Zufriedenheit, an Motivation oder an Verständnis. Vielleicht aber auch im physischen Bereich: Ein Körperteil, Zähne oder Körperfunktionen.","24":"Zumeist ein blonder, gefühlvoller junger Mann, sehr herzlich und von einem bezauberndem Wesen. Man muss ihn einfach mögen. (ev. Liebhaber)","25":"Dieser Mensch hat ein gutes Selbstverständnis und steht mit beiden Beinen fest auf dem Boden. Er liebt die Lust und die Sinnlichkeit und ist ansonsten sehr solide und hängt an alten Wertevorstellungen.","26":"Dieser Mensch ist ein verschlossener, lernfreudiger Charakter. Sehr oft weiß er mehr als er vorgibt.","27":"Dies ist ein sehr entschlußfreudiger Mensch, der aber vielleicht auch etwas oberflächlich erscheint. Vielleicht ist es aber auch ein Mensch, den man noch nicht so genau kennt.","28":"Diese Person ist dir bereits bekannt.","29":"weibliche Hauptperson, Freundin, Fragestellerin, Herzensdame, Seelenpartnerin","30":"Dies ist zumeist ein intelligenter, älterer, vornehmer, langmütiger Mann. Er liebt schöne Dinge und Luxus und ist nicht so leicht zu durchschauen. Er kann dein Ritter sein, aber auch dein wildester Traum.","31":"Dies ist eine große und charismatische Person. Wenn sie den Raum betritt, wird es scheinbar etwas heller darin. Sie ist sehr erfolgreich und man kann sich diesem gewinnenden Wesen schwer entziehen.","32":"Dieser Mensch ist eine emotionale, manchmal stimmungsschwankende Person mit künstlerischen Ambitionen und auf dem Wege, berühmt zu werden, wenn er es nicht schon ist. Jedenfalls möchte er es gerne.","33":"Dieser Mensch ist eine Person, die sich immer zu helfen weiß und für jedes Problem auch die richtige Lösung hat, so wie zum Beispiel Mac Gyver.","34":"Dies ist ein tüchtiger, eher materiell eingestellter Mensch, fleißig, wenngleich auch ein wenig (fischig) langweilig.","35":"Dies ist eine solide und vertrauenswürdige Person.","36":"Dies ist eine eher seriöse und disziplinierte Person, die in ihrem Leben schon viel Schicksalsschläge erdulden musste."};


function getCombo(a, b) {
  if (!a || !b || a === b) return null;
  const lo = Math.min(a, b), hi = Math.max(a, b);
  return COMBOS[`${lo}-${hi}`] || null;
}

const CARD_NUMS = Array.from({length: 36}, (_, i) => i + 1);

// Matrix position layout:
// [0]=Gendanken  [1]=Ist-Situation(KOMBI)  [2]=Rat der Engel
// [3]=Warnung    [4]=SIGNIFIKATOR          [5]=Nahe Zukunft(KOMBI)
// [6]=Wo herkommt [7]=Unbewusste(KOMBI)   [8]=Ergebnis und wann

const POSITION_LABELS = [
  "Gedanken", "Ist-Situation", "Rat der Engel",
  "Warnung", "Signifikator", "Nahe Zukunft",
  "Wo es herkommt", "Unbewusste Zukunft", "Ergebnis und wann"
];
// Gleiche Positionen wie POSITION_LABELS, aber mit der Dramaturgie-Bezeichnung erweitert
// (genau wie über den Schreibfeldern im Writing-Bereich) — nur für das 3x3-Raster dort,
// damit der echte Matrix-Bereich weiterhin die schlichten Lenormand-Begriffe zeigt.
const WRITING_POSITION_LABELS = [
  "Gedanken | Anfang", "IST-Situation | 1. Katastrophe", "Rat der Engel | 2. Katastrophe",
  "Warnung | Katharsis", "Signifikator | Thema", "Nahe Zukunft | Mittelteil",
  "Ursache | 3. Katastrophe", "Unbewusste Zukunft | Rückzug", "Ergebnis | Pay Off"
];
const KOMBI_POSITIONS = [1, 5, 7]; // positions that show combinations
const MATRIX_FIELDS = ["gendanken", "ist_situation", "rat_der_engel", "warnung", "signifikator", "nahe_zukunft", "wo_es_herkommt", "unbewusste_zukunft", "ergebnis_und_wann"];
const MATRIX_KEYS = ["gendanken", null, "rat_der_engel", "warnung", null, null, "wo_es_herkommt", null, "ergebnis_und_wann"];

// Sprechende Bezeichnungen für die Felder einer Writing-Vorlage (für die Vorschau)
const TEMPLATE_FIELD_LABELS = {
  intro: "Intro",
  "4": "Signifikator", "0": "Gedanken", "1": "IST-Situation", "2": "Rat der Engel",
  "5": "Nahe Zukunft", nachRatDerEngel: "Subplot",
  "6": "Ursache", "7": "Unbewusste Zukunft", "3": "Warnung", "8": "Ergebnis",
  outro: "Outro"
};

// Personen-spezifische Bezeichnungen für die Writing-Positionen, wenn writingMode === "personen" —
// die normalen Labels ("Rat der Engel", "Katharsis" etc.) passen nicht zu einer Personenbeschreibung.
// Muss exakt zur perKeys-Reihenfolge in getMatrixText passen: [sternzeichen, haarfarbe, charakter, figur, -, beruf, groesse, alter, woher]
const PERSONEN_POSITION_LABELS = {
  "4": "Signifikator | Die Person", "0": "Sternzeichen", "1": "Haarfarbe",
  "2": "Charakter", "3": "Figur", "5": "Beruf", "6": "Größe", "7": "Alter", "8": "Woher"
};

// Textarea, die mit ihrem Inhalt mitwächst statt zu scrollen
function AutoTextarea({ value, onChange, placeholder, style, minRows = 2, ...rest }) {
  const ref = React.useRef(null);
  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = el.scrollHeight + "px";
  }, [value]);
  return (
    <textarea
      ref={ref}
      value={value}
      onChange={onChange}
      placeholder={placeholder}
      rows={minRows}
      style={{ ...style, overflow:"hidden", resize:"none" }}
      {...rest}
    />
  );
}

function ConfettiCanvas() {
  const canvasRef = React.useRef(null);
  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    const colors = ["#c8a96e","#d4b878","#f0e8d8","#ffffff","#b89aff","#ff9ad4","#9affe0","#ffed4a"];
    const pieces = Array.from({length:150}, () => ({
      x: Math.random() * canvas.width,
      y: Math.random() * -canvas.height,
      w: 5 + Math.random()*8,
      h: 8 + Math.random()*14,
      color: colors[Math.floor(Math.random()*colors.length)],
      speed: 2 + Math.random()*4,
      angle: Math.random()*360,
      spin: (Math.random()-0.5)*4,
      wobble: Math.random()*2,
      wobbleSpeed: 0.05 + Math.random()*0.1,
      wobblePos: Math.random()*Math.PI*2,
    }));
    let running = true;
    const draw = () => {
      if (!running) return;
      ctx.clearRect(0,0,canvas.width,canvas.height);
      pieces.forEach(p => {
        p.y += p.speed;
        p.wobblePos += p.wobbleSpeed;
        p.angle += p.spin;
        const wx = p.x + Math.sin(p.wobblePos) * 15;
        if (p.y > canvas.height + 20) {
          p.y = -20;
          p.x = Math.random() * canvas.width;
        }
        ctx.save();
        ctx.translate(wx, p.y);
        ctx.rotate(p.angle * Math.PI/180);
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.w/2, -p.h/2, p.w, p.h);
        ctx.restore();
      });
      requestAnimationFrame(draw);
    };
    draw();
    return () => { running = false; };
  }, []);
  return <canvas ref={canvasRef} style={{ position:"absolute", inset:0, width:"100%", height:"100%" }}/>;
}


// Eigenständige, stabile Komponente außerhalb von LenormandApp definiert — wichtig, damit
// sie bei jedem Tastendruck NICHT neu erzeugt wird. Wäre sie (wie ursprünglich) innerhalb
// von LenormandApp verschachtelt, würde jeder Tastendruck (der ja den State und damit ein
// Re-Render der riesigen Hauptkomponente auslöst) die Funktion neu definieren — React kann
// das DOM-<textarea>-Element dann nicht mehr zuverlässig wiederverwenden und der Cursor/Fokus
// springt weg, noch bevor das erste Zeichen sichtbar wird. Mit eigenem lokalem State hier
// bleibt die Texteingabe komplett unabhängig von allem, was in LenormandApp passiert, bis
// "Speichern" gedrückt wird.
function InlineEditBox({ initialValue, onSave, onCancel, rows, fontSize, lightMode }) {
  const [value, setValue] = useState(initialValue);
  return (
    <div>
      <textarea value={value} onChange={e => setValue(e.target.value)} rows={rows || 3} autoFocus
        style={{ width:"100%", padding:"8px 10px", marginBottom:8, background:"rgba(200,169,110,0.04)", border:`1px solid ${lightMode?"rgba(80,30,120,0.3)":"rgba(200,169,110,0.2)"}`, borderRadius:6, color:lightMode?"#2a0850":"#d4c4a0", fontFamily:"Georgia,serif", fontSize:fontSize || 12, outline:"none", boxSizing:"border-box", resize:"none", lineHeight:1.6 }} />
      <div style={{ display:"flex", gap:8 }}>
        <button onClick={() => onSave(value)} style={{ background:"rgba(200,169,110,0.12)", border:"1px solid #c8a96e", color:lightMode?"#5a1080":"#c8a96e", padding:"5px 14px", borderRadius:6, cursor:"pointer", fontSize:11, fontFamily:"Georgia,serif" }}>Speichern</button>
        <button onClick={onCancel} style={{ background:"transparent", border:`1px solid ${lightMode?"rgba(80,30,120,0.3)":"rgba(200,169,110,0.2)"}`, color:lightMode?"#2a0850":"#9a8060", padding:"5px 14px", borderRadius:6, cursor:"pointer", fontSize:11, fontFamily:"Georgia,serif" }}>Abbrechen</button>
      </div>
    </div>
  );
}

// Gleiches Prinzip wie InlineEditBox, nur mit zwei Feldern (Titel + Text) für die
// Bearbeitung eines ganzen Beitrags statt nur einer Antwort.
// Fängt Render-Abstürze in einem Teilbereich ab und zeigt den Fehlertext an, statt die
// ganze App schwarz werden zu lassen. Hilft, Probleme sichtbar zu machen statt "blank".
class ContentErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { err: null }; }
  static getDerivedStateFromError(err) { return { err }; }
  render() {
    if (this.state.err) {
      return (
        <div style={{ padding: 24, color: "#e0b0b0", fontFamily: "monospace", fontSize: 12, whiteSpace: "pre-wrap", lineHeight: 1.6 }}>
          ⚠️ Fehler beim Anzeigen dieses Bereichs:{"\n"}
          {String((this.state.err && this.state.err.message) || this.state.err)}
        </div>
      );
    }
    return this.props.children;
  }
}

function InlinePostEditBox({ initialTitle, initialBody, onSave, onCancel, lightMode }) {
  const [title, setTitle] = useState(initialTitle);
  const [body, setBody] = useState(initialBody);
  return (
    <div>
      <input type="text" value={title} onChange={e => setTitle(e.target.value)} autoFocus
        style={{ width:"100%", padding:"8px 10px", marginBottom:8, background:"rgba(200,169,110,0.04)", border:`1px solid ${lightMode?"rgba(80,30,120,0.3)":"rgba(200,169,110,0.2)"}`, borderRadius:6, color:lightMode?"#5a1080":"#c8a96e", fontFamily:"Georgia,serif", fontSize:14, outline:"none", boxSizing:"border-box" }} />
      <textarea value={body} onChange={e => setBody(e.target.value)} rows={4}
        style={{ width:"100%", padding:"9px 12px", marginBottom:8, background:"rgba(200,169,110,0.04)", border:`1px solid ${lightMode?"rgba(80,30,120,0.3)":"rgba(200,169,110,0.2)"}`, borderRadius:7, color:lightMode?"#2a0850":"#d4c4a0", fontFamily:"Georgia,serif", fontSize:13, outline:"none", boxSizing:"border-box", resize:"none", lineHeight:1.6 }} />
      <div style={{ display:"flex", gap:8 }}>
        <button onClick={() => onSave(title, body)} style={{ background:"rgba(200,169,110,0.12)", border:"1px solid #c8a96e", color:lightMode?"#5a1080":"#c8a96e", padding:"6px 16px", borderRadius:6, cursor:"pointer", fontSize:12, fontFamily:"Georgia,serif" }}>Speichern</button>
        <button onClick={onCancel} style={{ background:"transparent", border:`1px solid ${lightMode?"rgba(80,30,120,0.3)":"rgba(200,169,110,0.2)"}`, color:lightMode?"#2a0850":"#9a8060", padding:"6px 16px", borderRadius:6, cursor:"pointer", fontSize:12, fontFamily:"Georgia,serif" }}>Abbrechen</button>
      </div>
    </div>
  );
}

// Gleiches Prinzip wie InlineEditBox/InlinePostEditBox — eigener lokaler State, damit
// das Tippen in den Feldern unabhängig von Re-Renders der Hauptkomponente bleibt.
function CategoryEditBox({ initialName, initialDescription, initialIcon, initialVisibility, initialGuestPost, onSave, onCancel, gold, lightMode }) {
  const [name, setName] = useState(initialName);
  const [description, setDescription] = useState(initialDescription);
  const [icon, setIcon] = useState(initialIcon);
  const [visibility, setVisibility] = useState(initialVisibility);
  const [guestPost, setGuestPost] = useState(initialGuestPost);
  return (
    <div style={{ background:"rgba(200,169,110,0.04)", border:`1px solid ${lightMode?"rgba(80,30,120,0.3)":"rgba(200,169,110,0.2)"}`, borderRadius:10, padding:16, marginBottom:10 }}>
      <input placeholder="Name der Kategorie" value={name} onChange={e => setName(e.target.value)} autoFocus
        style={{ width:"100%", padding:"8px 10px", marginBottom:8, background:"rgba(200,169,110,0.04)", border:`1px solid ${lightMode?"rgba(80,30,120,0.3)":"rgba(200,169,110,0.2)"}`, borderRadius:6, color:lightMode?"#2a0850":"#d4c4a0", fontFamily:"Georgia,serif", fontSize:13, outline:"none", boxSizing:"border-box" }} />
      <input placeholder="Beschreibung (optional, ein kurzer Satz)" value={description} onChange={e => setDescription(e.target.value)}
        style={{ width:"100%", padding:"8px 10px", marginBottom:8, background:"rgba(200,169,110,0.04)", border:`1px solid ${lightMode?"rgba(80,30,120,0.3)":"rgba(200,169,110,0.2)"}`, borderRadius:6, color:lightMode?"#2a0850":"#d4c4a0", fontFamily:"Georgia,serif", fontSize:13, outline:"none", boxSizing:"border-box" }} />
      <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:8 }}>
        <div style={{ fontSize:9, color:lightMode?"#2a0850":"#7a6040", letterSpacing:1 }}>Icon</div>
        <input placeholder="z.B. 💬" value={icon} maxLength={4} onChange={e => setIcon(e.target.value)}
          style={{ width:60, padding:"6px 8px", textAlign:"center", background:"rgba(200,169,110,0.04)", border:`1px solid ${lightMode?"rgba(80,30,120,0.3)":"rgba(200,169,110,0.2)"}`, borderRadius:6, color:lightMode?"#2a0850":"#d4c4a0", fontFamily:"Georgia,serif", fontSize:14, outline:"none" }} />
        <div style={{ fontSize:9, color:lightMode?"#2a0850":"#5a4a34" }}>nur 1 Emoji, kein Text — Vorschau:</div>
        <span style={{ fontSize:22 }}>{icon}</span>
      </div>
      <div style={{ display:"flex", gap:8, marginBottom:8 }}>
        {[["guest","🌍 Alle (auch Gäste)"],["member","👥 Nur Mitglieder"],["pro","⭐ Nur Pro"]].map(([v,l]) => (
          <button key={v} onClick={() => setVisibility(v)} style={{ flex:1, background:visibility===v?"rgba(200,169,110,0.15)":"transparent", border:`1px solid ${visibility===v?gold:"rgba(200,169,110,0.2)"}`, color:visibility===v?gold:"#7a6040", padding:"6px 8px", borderRadius:5, cursor:"pointer", fontSize:10, fontFamily:"Georgia,serif" }}>{l}</button>
        ))}
      </div>
      <label style={{ display:"flex", alignItems:"center", gap:6, marginBottom:10, fontSize:11, color:lightMode?"#2a0850":"#9a8060", cursor:"pointer" }}>
        <input type="checkbox" checked={guestPost} onChange={e => setGuestPost(e.target.checked)} />
        Gäste dürfen hier auch ohne Login schreiben (z.B. für Mitmach-Mittwoch)
      </label>
      <div style={{ display:"flex", gap:8 }}>
        <button onClick={() => onSave({ name, description, icon, visibility, guestPost })}
          style={{ flex:1, background:"rgba(200,169,110,0.12)", border:`1px solid ${gold}`, color:gold, padding:"8px", borderRadius:6, cursor:"pointer", fontSize:12, fontFamily:"Georgia,serif" }}>Speichern</button>
        <button onClick={onCancel}
          style={{ background:"transparent", border:`1px solid ${lightMode?"rgba(80,30,120,0.3)":"rgba(200,169,110,0.2)"}`, color:lightMode?"#2a0850":"#9a8060", padding:"8px 16px", borderRadius:6, cursor:"pointer", fontSize:12, fontFamily:"Georgia,serif" }}>Abbrechen</button>
      </div>
    </div>
  );
}

// Gleiches Prinzip wie die anderen Edit-Boxen — eigener lokaler State damit Fokus beim
// Tippen stabil bleibt, unabhängig von Re-Renders der Hauptkomponente.
function ProfileEditBox({ initialName, initialBio, initialSignature, initialBirthdate, initialGender, saveStatus, onSave, onCancel, gold, lightMode }) {
  const [name, setName] = useState(initialName);
  const [bio, setBio] = useState(initialBio);
  const [signature, setSignature] = useState(initialSignature);
  const [birthdate, setBirthdate] = useState(initialBirthdate || "");
  const [gender, setGender] = useState(initialGender || "");
  return (
    <div>
      <div style={{ width:64, height:64, borderRadius:"50%", background:"rgba(200,169,110,0.12)", border:`1px solid ${gold}`, display:"flex", alignItems:"center", justifyContent:"center", fontSize:26, color:gold, fontFamily:"Georgia,serif", margin:"0 auto 18px" }}>
        {(name || "?").trim().charAt(0).toUpperCase() || "?"}
      </div>
      <div style={{ fontSize:10, color:lightMode?"#2a0850":"#7a6040", marginBottom:5 }}>Name</div>
      <input type="text" value={name} onChange={e => setName(e.target.value)} autoFocus
        style={{ width:"100%", padding:"9px 12px", marginBottom:14, background:"rgba(200,169,110,0.04)", border:`1px solid ${lightMode?"rgba(80,30,120,0.3)":"rgba(200,169,110,0.2)"}`, borderRadius:7, color:lightMode?"#2a0850":"#d4c4a0", fontFamily:"Georgia,serif", fontSize:13, outline:"none", boxSizing:"border-box" }} />
      <div style={{ fontSize:10, color:lightMode?"#2a0850":"#7a6040", marginBottom:5 }}>Über mich</div>
      <textarea value={bio} onChange={e => setBio(e.target.value)} rows={4} placeholder="Erzähl ein bisschen über dich…"
        style={{ width:"100%", padding:"9px 12px", marginBottom:14, background:"rgba(200,169,110,0.04)", border:`1px solid ${lightMode?"rgba(80,30,120,0.3)":"rgba(200,169,110,0.2)"}`, borderRadius:7, color:lightMode?"#2a0850":"#d4c4a0", fontFamily:"Georgia,serif", fontSize:13, outline:"none", boxSizing:"border-box", resize:"none", lineHeight:1.6 }} />
      <div style={{ display:"flex", gap:10, marginBottom:14 }}>
        <div style={{ flex:1 }}>
          <div style={{ fontSize:10, color:lightMode?"#2a0850":"#7a6040", marginBottom:5 }}>Geburtsdatum <span style={{ fontSize:9, color:lightMode?"#2a0850":"#5a4a34", fontStyle:"italic" }}>(optional)</span></div>
          <input type="date" value={birthdate} onChange={e => setBirthdate(e.target.value)}
            style={{ width:"100%", padding:"9px 12px", background:"rgba(200,169,110,0.04)", border:`1px solid ${lightMode?"rgba(80,30,120,0.3)":"rgba(200,169,110,0.2)"}`, borderRadius:7, color:lightMode?"#2a0850":"#d4c4a0", fontFamily:"Georgia,serif", fontSize:13, outline:"none", boxSizing:"border-box", colorScheme:"dark" }} />
        </div>
      </div>
      <div style={{ fontSize:10, color:lightMode?"#2a0850":"#7a6040", marginBottom:5 }}>Geschlecht <span style={{ fontSize:9, color:lightMode?"#2a0850":"#5a4a34", fontStyle:"italic" }}>(optional)</span></div>
      <div style={{ display:"flex", gap:8, marginBottom:14 }}>
        {[["weiblich","weiblich"],["männlich","männlich"],["sag ich nicht","sag ich nicht"]].map(([v,l]) => (
          <button key={v} onClick={() => setGender(g => g === v ? "" : v)}
            style={{ flex:1, background:gender===v?"rgba(200,169,110,0.15)":"transparent", border:`1px solid ${gender===v?gold:"rgba(200,169,110,0.2)"}`, color:gender===v?gold:"#7a6040", padding:"7px 6px", borderRadius:6, cursor:"pointer", fontSize:11, fontFamily:"Georgia,serif" }}>
            {l}
          </button>
        ))}
      </div>
      <div style={{ fontSize:10, color:lightMode?"#2a0850":"#7a6040", marginBottom:5 }}>Signatur <span style={{ fontSize:9, color:lightMode?"#2a0850":"#5a4a34", fontStyle:"italic" }}>(erscheint unter deinen Beiträgen &amp; Antworten)</span></div>
      <input type="text" value={signature} onChange={e => setSignature(e.target.value)} maxLength={120} placeholder="z.B. wer Mut hat selbst zu denken, hat auch Freiheit, selbst zu handeln"
        style={{ width:"100%", padding:"9px 12px", marginBottom:4, background:"rgba(200,169,110,0.04)", border:`1px solid ${lightMode?"rgba(80,30,120,0.3)":"rgba(200,169,110,0.2)"}`, borderRadius:7, color:lightMode?"#2a0850":"#d4c4a0", fontFamily:"Georgia,serif", fontSize:12, outline:"none", boxSizing:"border-box", fontStyle:"italic" }} />
      <div style={{ fontSize:9, color:lightMode?"#2a0850":"#5a4a34", marginBottom:18, textAlign:"right" }}>{signature.length}/120</div>
      <div style={{ display:"flex", gap:8 }}>
        <button onClick={() => onSave({ name, bio, signature, birthdate, gender })} disabled={saveStatus==="saving"}
          style={{ flex:1, background:"rgba(200,169,110,0.12)", border:`1px solid ${gold}`, color:gold, padding:"9px", borderRadius:7, cursor:"pointer", fontSize:13, fontFamily:"Georgia,serif", opacity: saveStatus==="saving" ? 0.6 : 1 }}>
          {saveStatus==="saving" ? "Speichert…" : "Speichern"}
        </button>
        <button onClick={onCancel}
          style={{ background:"transparent", border:`1px solid ${lightMode?"rgba(80,30,120,0.3)":"rgba(200,169,110,0.2)"}`, color:lightMode?"#2a0850":"#9a8060", padding:"9px 16px", borderRadius:7, cursor:"pointer", fontSize:13, fontFamily:"Georgia,serif" }}>
          Abbrechen
        </button>
      </div>
      {saveStatus==="error" && <div style={{fontSize:11, color:"#c87a6a", marginTop:10, textAlign:"center"}}>Konnte nicht gespeichert werden, versuch's gleich noch mal.</div>}
    </div>
  );
}

// Schmale, immer sichtbare Leiste ganz oben — nur für Admins. Kernstück ist der
// Account-Switcher: zwischen gemerkten Test-Accounts wechseln, ohne sich jedes Mal
// neu einzuloggen. Die Liste liegt server-seitig, erscheint also auf jedem Gerät
// gleich, auf dem man sich als Admin einloggt.
function AdminBar({ gold, lightMode, displayName, myEmail, accounts, accountsLoading, onOpen, open, onClose,
                     onSwitch, switching, onForget, addOpen, onAddOpen, onAddCancel,
                     onAddSubmit, addMsg, isRealAdmin, onBackToAdmin, switchingBack }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  return (
    <>
      <div style={{ position:"fixed", top:0, left:0, right:0, zIndex:2000, background:lightMode?"#c8a8e0":"linear-gradient(to bottom, #120820, #0a0612)", borderBottom:`1px solid ${lightMode?"rgba(150,100,200,0.3)":"rgba(200,169,110,0.15)"}`, display:"flex", alignItems:"center", justifyContent:"space-between", padding:"6px 14px", fontSize:11, fontFamily:"Georgia,serif" }}>
        <div style={{ color:lightMode?"#2a0850":"#7a6040", letterSpacing:1 }}>
          {isRealAdmin ? "👑 Admin" : "🧪 Test-Account"} · {displayName}
        </div>
        <div style={{ display:"flex", gap:8 }}>
          {!isRealAdmin && (
            <button onClick={onBackToAdmin} disabled={switchingBack}
              style={{ background:"rgba(200,169,110,0.15)", border:`1px solid ${gold}`, color:gold, padding:"4px 12px", borderRadius:14, cursor:"pointer", fontSize:11, fontFamily:"Georgia,serif", opacity:switchingBack?0.6:1 }}>
              {switchingBack ? "Wechselt…" : "← Zurück zu Admin"}
            </button>
          )}
          {isRealAdmin && (
            <button onClick={onOpen} style={{ background:"rgba(200,169,110,0.1)", border:`1px solid ${gold}`, color:gold, padding:"4px 12px", borderRadius:14, cursor:"pointer", fontSize:11, fontFamily:"Georgia,serif" }}>
              🔀 Accounts{accounts.length > 0 ? ` (${accounts.length})` : ""}
            </button>
          )}
        </div>
      </div>
      {/* Platzhalter, damit die fest positionierte Leiste den Seiteninhalt nicht überdeckt */}
      <div style={{ height:30 }} />

      {open && (
        <div style={{ position:"fixed", inset:0, background:lightMode?"rgba(80,30,120,0.4)":"rgba(8,5,18,0.85)", display:"flex", alignItems:"flex-start", justifyContent:"center", zIndex:2100, padding:"60px 20px 20px" }}
          onClick={onClose}>
          <div onClick={e => e.stopPropagation()}
            style={{ background:lightMode?"#f5eef8":"#0f0a1a", border:`1px solid ${lightMode?"rgba(80,30,120,0.3)":"rgba(200,169,110,0.3)"}`, borderRadius:12, padding:"22px 20px", maxWidth:380, width:"100%", maxHeight:"80vh", overflowY:"auto" }}>
            <div style={{ fontSize:14, color:gold, marginBottom:4 }}>🔀 Account-Switcher</div>
            <div style={{ fontSize:11, color:lightMode?"#2a0850":"#7a6040", marginBottom:16 }}>Synchronisiert sich über alle Geräte — wechselt direkt ohne erneutes Einloggen.</div>

            {accountsLoading ? (
              <div style={{ fontSize:12, color:lightMode?"#2a0850":"#7a6040", fontStyle:"italic", marginBottom:14 }}>Lädt…</div>
            ) : accounts.length === 0 ? (
              <div style={{ fontSize:12, color:lightMode?"#2a0850":"#7a6040", fontStyle:"italic", marginBottom:14 }}>Noch keine weiteren Accounts gemerkt — logg dich einmal in einen Test-Account ein, dann erscheint er hier.</div>
            ) : accounts.map(acc => {
                const isMe = acc.account_email === myEmail;
                const isSwitching = switching === acc.id;
                return (
                  <div key={acc.id} style={{ display:"flex", alignItems:"center", gap:8, padding:"9px 10px", marginBottom:6, background: isMe ? "rgba(200,169,110,0.1)" : "rgba(200,169,110,0.03)", border:`1px solid ${isMe?gold:"rgba(200,169,110,0.15)"}`, borderRadius:7 }}>
                    <div style={{ flex:1, minWidth:0 }}>
                      <div style={{ fontSize:12, color: isMe ? gold : "#d4c4a0", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{acc.account_email}</div>
                      {isMe && <div style={{ fontSize:9, color:gold }}>● aktuell aktiv</div>}
                    </div>
                    {!isMe && (
                      <button onClick={() => onSwitch(acc)} disabled={isSwitching}
                        style={{ background:"rgba(200,169,110,0.12)", border:`1px solid ${gold}`, color:gold, padding:"5px 12px", borderRadius:6, cursor:"pointer", fontSize:11, fontFamily:"Georgia,serif", flexShrink:0, opacity:isSwitching?0.6:1 }}>
                        {isSwitching ? "Wechselt…" : "Wechseln"}
                      </button>
                    )}
                    <button onClick={() => onForget(acc.id)}
                      title="Aus der Liste entfernen (loggt nicht aus)"
                      style={{ background:"transparent", border:"none", color:"#9a6050", cursor:"pointer", fontSize:13, flexShrink:0 }}>✕</button>
                  </div>
                );
              })}

            {addOpen ? (
              <div style={{ marginTop:14, paddingTop:14, borderTop:`1px solid ${lightMode?"rgba(80,30,120,0.3)":"rgba(200,169,110,0.15)"}` }}>
                <input type="email" placeholder="E-Mail" value={email} onChange={e => setEmail(e.target.value)} autoFocus
                  style={{ width:"100%", padding:"8px 10px", marginBottom:8, background:"rgba(200,169,110,0.04)", border:`1px solid ${lightMode?"rgba(80,30,120,0.3)":"rgba(200,169,110,0.2)"}`, borderRadius:6, color:lightMode?"#2a0850":"#d4c4a0", fontFamily:"Georgia,serif", fontSize:12, outline:"none", boxSizing:"border-box" }} />
                <input type="password" placeholder="Passwort" value={password} onChange={e => setPassword(e.target.value)}
                  style={{ width:"100%", padding:"8px 10px", marginBottom:8, background:"rgba(200,169,110,0.04)", border:`1px solid ${lightMode?"rgba(80,30,120,0.3)":"rgba(200,169,110,0.2)"}`, borderRadius:6, color:lightMode?"#2a0850":"#d4c4a0", fontFamily:"Georgia,serif", fontSize:12, outline:"none", boxSizing:"border-box" }} />
                {addMsg && <div style={{ fontSize:11, color: addMsg.startsWith("✓") ? "#5a9a5a" : "#c87a6a", marginBottom:8 }}>{addMsg}</div>}
                <div style={{ display:"flex", gap:8 }}>
                  <button onClick={() => onAddSubmit(email, password)}
                    style={{ flex:1, background:"rgba(200,169,110,0.12)", border:`1px solid ${gold}`, color:gold, padding:"8px", borderRadius:6, cursor:"pointer", fontSize:12, fontFamily:"Georgia,serif" }}>
                    Hinzufügen
                  </button>
                  <button onClick={() => { setEmail(""); setPassword(""); onAddCancel(); }}
                    style={{ background:"transparent", border:`1px solid ${lightMode?"rgba(80,30,120,0.3)":"rgba(200,169,110,0.2)"}`, color:lightMode?"#2a0850":"#9a8060", padding:"8px 16px", borderRadius:6, cursor:"pointer", fontSize:12, fontFamily:"Georgia,serif" }}>
                    Abbrechen
                  </button>
                </div>
              </div>
            ) : (
              <button onClick={onAddOpen}
                style={{ width:"100%", marginTop:14, background:"transparent", border:"1px dashed rgba(200,169,110,0.3)", color:lightMode?"#2a0850":"#9a8060", padding:"9px", borderRadius:7, cursor:"pointer", fontSize:12, fontFamily:"Georgia,serif" }}>
                + Account hinzufügen, ohne mich auszuloggen
              </button>
            )}
          </div>
        </div>
      )}
    </>
  );
}

// Zeigt eine gespeicherte Frage-Deutung (Situations- oder Personen-Matrix) als echtes
// visuelles 3×3-Raster im Forum an — genau wie auf dem Bildschirm beim Deuten selbst,
// statt nur als Fließtext. data kommt aus forum_posts.matrix_data (siehe shareFrageToForum).
function ForumMatrixGrid({ data, gold, lightMode }) {
  if (!data || !Array.isArray(data.cells)) return null;
  const isPersonen = data.mode === "personen";
  return (
    <div style={{ marginTop:12, marginBottom:8 }}>
      {data.question && (
        <div style={{ fontSize:11, color:lightMode?"#2a0850":"#9a8060", fontStyle:"italic", marginBottom:10 }}>✦ {data.question}</div>
      )}
      <div style={{ display:"flex", alignItems:"center", gap:6, marginBottom:8 }}>
        <span style={{ fontSize:16 }}>{data.sigSymbol}</span>
        <span style={{ fontSize:12, color:gold }}>{data.sigName}</span>
        <span style={{ fontSize:9, color:lightMode?"#2a0850":"#5a4a34" }}>· {isPersonen ? "Personen-Matrix" : "Situations-Matrix"}</span>
      </div>
      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:6 }}>
        {data.cells.map((c, pos) => (
          <div key={pos} style={{
            background: c.isSig ? "rgba(200,169,110,0.08)" : c.isKombi ? "rgba(200,169,110,0.04)" : "rgba(200,169,110,0.02)",
            border: `1px solid ${c.isSig ? gold : c.isKombi ? "rgba(200,169,110,0.2)" : "rgba(200,169,110,0.1)"}`,
            borderRadius:7, padding:"8px 7px"
          }}>
            <div style={{ fontSize:8, letterSpacing:1, color: c.isKombi ? "rgba(212,184,120,0.8)" : "#8a7050", textTransform:"uppercase", marginBottom:4 }}>
              {c.label}{c.isKombi ? " ✦" : ""}
            </div>
            {c.card && (
              <div style={{ marginBottom:5, display:"flex", alignItems:"center", gap:3 }}>
                <span style={{fontSize:12}}>{c.cardSymbol}</span>
                <span style={{fontSize:7, color:gold}}>{c.cardName}</span>
              </div>
            )}
            {c.text ? (
              <div style={{ fontSize:11, color: c.isKombi ? "#d8c8a0" : "#c0b090", lineHeight:1.6 }}>{c.text}</div>
            ) : (
              <div style={{ fontSize:8, color:lightMode?"#2a0850":"#3a2a18", fontStyle:"italic" }}>–</div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ============================================================
// Notizzettel in Flammen — V3, portiert aus Claude Design.
// Kamera fest, transparent. Brandkante mit echten SVG-feGaussianBlur-
// Filtern (Safari rendert CSS-filter:blur auf SVG-Pfaden nicht weich).
// ============================================================
const ZettelBurn = (() => {
  const lerp = (a, b, t) => a + (b - a) * t;
  const clamp = (v, mn, mx) => Math.max(mn, Math.min(mx, v));
  const Easing = {
    easeInOutQuad: (t) => (t < 0.5 ? 2*t*t : -1 + (4 - 2*t)*t),
    easeInOutSine: (t) => -(Math.cos(Math.PI * t) - 1) / 2,
  };

  const W = 1080, H = 1920;
  const PW = 900, PH = 1440, PX = (W - PW) / 2, PY = 210;
  const BURN_START = 1.55, BURN_END = 6.85;

  function mulberry32(a) {
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      let t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }


  // Burn front position in paper-local Y (0 = paper top). Starts just below the
  // bottom edge (intact) and sweeps up past the top (consumed).
  function burnFront(t) {
    const cl = clamp;
    const p = cl((t - BURN_START) / (BURN_END - BURN_START), 0, 1);
    const e = Easing.easeInOutQuad(p);
    return lerp(PH + 6, -152, e);
  }
  // Diagonal tilt across the width — negative so the RIGHT side burns first.
  const SLANT = -132;

  // Jagged, time-crawling offset added to the front to make an organic edge.
  function edgeOffset(u, t) {
    return Math.sin(u * 7.3 + 1.3) * 17
         + Math.sin(u * 15.1 + 4.0) * 9
         + Math.sin(u * 29.7 + 2.2) * 5
         + Math.sin(u * 52.0 + 0.6) * 3
         + Math.sin(u * 88.0 + t * 9.0) * 2.6;
  }
  const edgeY = (u, t) => burnFront(t) + edgeOffset(u, t) + (u - 0.5) * SLANT;
  // Render edge for fire/glow: never let flames sit BELOW the paper's bottom edge
  // (otherwise the slanted start floats fire in the empty space beneath the sheet).
  const edgeYr = (u, t) => Math.min(edgeY(u, t), PH - 1);

  // Global fire intensity envelope: ignites ~1.7, dies down after the paper runs out.
  function flameEnv(t) {
    const cl = clamp;
    const ig = cl((t - 1.42) / 0.55, 0, 1);
    const out = 1 - cl((t - 6.5) / 1.65, 0, 1);
    return cl(ig, 0, 1) * cl(out, 0, 1);
  }

  // ── deterministic particle tables ──────────────────────────────────────────
  const RNG = mulberry32(20260628);
  const SPARKS = Array.from({ length: 150 }, () => {
    // ~55% during the active burn, ~45% reserved for the rise-to-universe finale
    const birth = RNG() < 0.55 ? lerp(1.95, 6.5, RNG()) : lerp(6.2, 9.3, RNG());
    return {
      birth, u: RNG(),
      vy: lerp(95, 245, RNG()), acc: lerp(8, 32, RNG()),
      drift: lerp(10, 42, RNG()), freq: lerp(2, 6, RNG()), phase: RNG() * 6.28,
      side: lerp(-28, 28, RNG()), life: lerp(0.7, 1.9, RNG()),
      size: lerp(2.2, 7, RNG()), hue: lerp(20, 44, RNG()),
    };
  });
  const ASH = Array.from({ length: 46 }, () => {
    const birth = lerp(5.4, 9.2, RNG());
    return {
      birth, u: RNG(), vy: lerp(26, 72, RNG()),
      drift: lerp(22, 64, RNG()), freq: lerp(0.8, 2.2, RNG()), phase: RNG() * 6.28,
      side: lerp(-32, 32, RNG()), life: lerp(2.4, 4.4, RNG()),
      size: lerp(5, 13, RNG()), rot: RNG() * 360, rots: lerp(-100, 100, RNG()),
      g: lerp(58, 120, RNG()),
    };
  });
  const TONGUES = Array.from({ length: 20 }, (_, i) => ({
    u: (i + 0.5) / 20 + lerp(-0.018, 0.018, RNG()),
    h: lerp(130, 320, RNG()), w: lerp(42, 84, RNG()),
    sway: lerp(6, 16, RNG()), sfreq: lerp(3, 7, RNG()),
    fr: lerp(7, 13, RNG()), ph: RNG() * 6.28, base: lerp(0.72, 1, RNG()),
  }));
  // Fine, fast-flickering licks layered on top of the main tongues for realism.
  const LICKS = Array.from({ length: 54 }, (_, i) => ({
    u: (i + 0.5) / 54 + lerp(-0.01, 0.01, RNG()),
    h: lerp(46, 168, RNG()), w: lerp(13, 30, RNG()),
    sway: lerp(4, 13, RNG()), sfreq: lerp(5, 11, RNG()),
    fr: lerp(11, 22, RNG()), ph: RNG() * 6.28, base: lerp(0.5, 1, RNG()),
  }));
  const SMOKE = Array.from({ length: 5 }, () => ({
    birth: lerp(4.3, 7.8, RNG()), x: lerp(0.28, 0.72, RNG()),
    vy: lerp(48, 86, RNG()), drift: lerp(40, 95, RNG()),
    size: lerp(190, 340, RNG()), life: lerp(3, 5.2, RNG()), ph: RNG() * 6.28,
  }));

  const WISHES = [
    'Klarheit für meinen Weg',
    'Mut, Neues zu wagen',
    'Liebe, die mich trägt',
    'Vertrauen ins Universum',
  ];

  // ── the paper itself (aged texture + handwritten checklist) ────────────────
  function Paper({ t, items, showWishes }) {
    const cl = clamp;
    const flick = 0.87 + 0.05 * Math.sin(t * 7 + 0.5) + 0.03 * Math.sin(t * 13);

    // clip-path keeps only the un-burned region (above the jagged front).
    const N = 62;
    let cp = `polygon(-40px -40px, ${PW + 40}px -40px`;
    for (let i = N; i >= 0; i--) {
      const u = i / N;
      const y = clamp(edgeY(u, t), -220, PH + 60);
      cp += `, ${(u * PW).toFixed(1)}px ${y.toFixed(1)}px`;
    }
    cp += ')';

    const ink = '#43301c';
    return (
      <div style={{
        position: 'absolute', inset: 0,
        clipPath: cp, WebkitClipPath: cp,
        filter: `brightness(${flick.toFixed(3)})`,
      }}>
        {/* aged paper body */}
        <div style={{
          position: 'absolute', inset: 0,
          background: `
            radial-gradient(120% 95% at 28% 18%, rgba(255,250,235,0.18), rgba(120,92,52,0.0) 42%),
            radial-gradient(58% 46% at 76% 66%, rgba(146,104,56,0.26), transparent 62%),
            radial-gradient(42% 30% at 18% 82%, rgba(112,80,42,0.30), transparent 60%),
            radial-gradient(30% 24% at 84% 22%, rgba(120,86,46,0.22), transparent 60%),
            linear-gradient(176deg, #ecdcb6 0%, #e1cd9f 46%, #d3bb88 100%)`,
          boxShadow: 'inset 0 0 70px rgba(86,58,26,0.40), inset 0 -40px 80px rgba(70,44,18,0.28)',
          borderRadius: '5px 8px 6px 7px',
        }} />
        {/* faint horizontal fold */}
        <div style={{
          position: 'absolute', left: 0, right: 0, top: '43%', height: 2,
          background: 'linear-gradient(90deg, transparent, rgba(96,64,28,0.22) 18%, rgba(96,64,28,0.22) 82%, transparent)',
        }} />

        {/* handwritten content */}
        <div style={{
          position: 'absolute', inset: 0, padding: '110px 92px 90px',
          display: 'flex', flexDirection: 'column',
          fontFamily: '"Caveat", cursive', color: ink,
        }}>
          <div style={{ fontSize: 40, opacity: 0.6, letterSpacing: '0.02em' }}>
            Vollmond&nbsp;✦&nbsp;Neumond&nbsp;✦&nbsp;Zaubermond
          </div>

          <div style={{ fontSize: 98, fontWeight: 700, lineHeight: 1.0, marginTop: 14 }}>
            Was ich mir wünsche
          </div>
          <div style={{
            width: 470, height: 6, marginTop: 8, transform: 'rotate(-0.7deg)',
            background: 'linear-gradient(90deg, rgba(67,48,28,0.85), rgba(67,48,28,0.15))',
            borderRadius: 3,
          }} />

          {showWishes && items && items.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 30, marginTop: 64 }}>
            {items.map((it, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 24, opacity: it.done ? 0.6 : 1 }}>
                <span style={{
                  flex: '0 0 auto', width: 30, height: 30, marginTop: 14,
                  border: '3px solid rgba(67,48,28,0.62)', borderRadius: '50%',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  transform: `rotate(${i % 2 ? -6 : 5}deg) scale(${i % 2 ? 1.04 : 0.95})`,
                }}>{it.done ? <span style={{ fontSize: 28, lineHeight: 1, color: ink, marginTop: -8 }}>✓</span> : null}</span>
                <span style={{ fontSize: 52, lineHeight: 1.18, textDecoration: it.done ? 'line-through' : 'none' }}>{it.text}</span>
              </div>
            ))}
          </div>
          )}
        </div>
      </div>
    );
  }

  // ── warm fire light, CLIPPED to the remaining paper (no spill into the void) ─
  function FireGlow({ t }) {
    const env = flameEnv(t);
    if (env < 0.04) return null;
    const cl = clamp;
    // same clip as the paper — keeps the glow only over the un-burned sheet,
    // so nothing leaks below or left of the actual paper edge
    const N = 48;
    let cp = `polygon(0px -60px, ${PW}px -60px`;
    for (let i = N; i >= 0; i--) {
      const u = i / N;
      const y = cl(edgeYr(u, t) + 10, -220, PH);
      cp += `, ${(u * PW).toFixed(1)}px ${y.toFixed(1)}px`;
    }
    cp += ')';
    const fy = burnFront(t);
    const flick = 0.82 + 0.18 * Math.sin(t * 21) + 0.1 * Math.sin(t * 7 + 1);
    return (
      <div style={{
        position: 'absolute', inset: 0, clipPath: cp, WebkitClipPath: cp,
        mixBlendMode: 'screen', pointerEvents: 'none',
        opacity: env * cl(flick, 0.4, 1.1),
        background: `radial-gradient(150% 300px at 50% ${fy.toFixed(0)}px, rgba(255,150,52,0.62), rgba(220,72,16,0.30) 38%, transparent 70%)`,
      }} />
    );
  }

  // ── glowing char / ember rim that follows the burn front ───────────────────
  // Three stacked bands, bottom→top, matching a real burning-paper edge:
  //   1) bright flickering EMBER line (white-hot core → orange → red)
  //   2) dense BLACK CARBONIZED band right behind it
  //   3) translucent LIGHT-BROWN SCORCH fading up into the intact paper
  // Brandkante über zwei Canvas-Ebenen (GPU): scharf gezeichnet, dann CSS-blur auf
  // dem Canvas-Element selbst — Safari weichzeichnet Canvas auf der Grafikkarte (anders
  // als SVG-Pfade). Eine Ebene für den verkohlten Rand, eine für die leuchtende Glut.
  function EmberRim({ t }) {
    const charRef = React.useRef(null);
    const emberRef = React.useRef(null);
    React.useEffect(() => {
      const cc = charRef.current, ec = emberRef.current;
      if (!cc || !ec) return;
      const cx = cc.getContext('2d'), ex = ec.getContext('2d');
      cx.clearRect(0, 0, PW, PH);
      ex.clearRect(0, 0, PW, PH);

      const front = burnFront(t);
      const env = flameEnv(t);
      if (front < -96 || front > PH + 40 || env < 0.04) return; // noch keine Glut

      const N = 80;
      const pts = [];
      for (let i = 0; i <= N; i++) pts.push({ x: (i / N) * PW, y: edgeYr(i / N, t) });
      const trace = (ctx, dy) => {
        ctx.beginPath();
        ctx.moveTo(pts[0].x, pts[0].y + dy);
        for (let i = 1; i <= N; i++) ctx.lineTo(pts[i].x, pts[i].y + dy);
      };
      const stroke = (ctx, color, w, a, dy) => {
        ctx.globalAlpha = a; ctx.strokeStyle = color; ctx.lineWidth = w;
        trace(ctx, dy); ctx.stroke();
      };
      const eo = 0.5 + 0.5 * env;

      // verkohlter Rand: heller Schorf federt ins Papier, dann dichte schwarze Kohle
      cx.lineCap = 'round'; cx.lineJoin = 'round';
      stroke(cx, '#9a6a38', 46, 0.42, -66);
      stroke(cx, '#5e3a18', 36, 0.70, -40);
      stroke(cx, '#241204', 34, 0.92, -13);
      stroke(cx, '#0a0502', 22, 0.98, -13);
      stroke(cx, '#070301', 10, 1.00, 0);

      // Glut: additiv ('lighter') zu rot→orange→gold→weißglühendem Kern
      ex.lineCap = 'round'; ex.lineJoin = 'round';
      ex.globalCompositeOperation = 'lighter';
      stroke(ex, '#ff2200', 16, 0.85 * eo, 0);
      stroke(ex, '#ff6a12', 9, 0.95 * eo, 0);
      stroke(ex, '#ffb43c', 4.5, 0.98 * eo, 0);
      stroke(ex, '#fff0c0', 1.8, 0.95 * eo, 0);

      // einzelne Glutpunkte, die aufblitzen und verlöschen
      for (let i = 2; i <= N - 2; i++) {
        const p = pts[i];
        const tw = Math.sin(t * (7 + (i % 6) * 1.7) + i * 1.3);
        const on = clamp(tw, -0.2, 1);
        if (on <= 0.02) continue;
        const r = 1.6 + 2.8 * on;
        ex.globalAlpha = (0.5 + 0.5 * on) * eo;
        ex.fillStyle = i % 3 ? '#ffd98a' : '#fff';
        ex.beginPath(); ex.arc(p.x, p.y - 1, r, 0, Math.PI * 2); ex.fill();
      }
    }, [t]);

    const base = { position: 'absolute', left: 0, top: 0, width: PW, height: PH, pointerEvents: 'none' };
    return (
      <>
        <canvas ref={charRef} width={PW} height={PH} style={{ ...base, filter: 'blur(7px)' }} />
        <canvas ref={emberRef} width={PW} height={PH} style={{ ...base, filter: 'blur(2.5px)' }} />
      </>
    );
  }

  // ── flame tongues anchored to the front ────────────────────────────────────
  function Flames({ t }) {
    const env = flameEnv(t);
    if (env < 0.02) return null;
    const cl = clamp;
    const out = [];

    // ── pointed flame tongues ────────────────────────────────────────────────
    const tongue = (s, key, scale, blurMul) => {
      const ey = edgeYr(s.u, t);
      if (ey < -70 || ey > PH + 34) return;
      const flick = 0.58 + 0.42 * Math.sin(t * s.fr + s.ph) + 0.14 * Math.sin(t * 24 + s.ph * 1.7);
      const fl = cl(flick, 0.2, 1.4);
      const h = s.h * fl * env * s.base * scale;
      const w = s.w * (0.78 + 0.26 * Math.sin(t * s.fr * 0.7 + s.ph));
      const sway = Math.sin(t * s.sfreq + s.ph) * s.sway + Math.sin(t * s.sfreq * 2.3 + s.ph) * s.sway * 0.4;
      const cx = s.u * PW + sway;
      // tip leans with the sway for a licking motion
      const lean = sway * 0.6;
      const op = env * cl(fl, 0.28, 1);
      // teardrop: rounded base, sharp tip (via lopsided border-radius + scaleY)
      out.push(<div key={'o' + key} style={{
        position: 'absolute', left: cx, top: ey - h, width: w, height: h,
        marginLeft: -w / 2, transformOrigin: '50% 100%',
        transform: `translateX(${lean}px) rotate(${lean * 0.05}deg)`,
        background: 'radial-gradient(ellipse 50% 58% at 50% 100%, #fff2c0 0%, #ffd24d 16%, #ff8a1e 38%, #ff3d00 62%, rgba(170,16,0,0.4) 82%, transparent 92%)',
        borderRadius: '50% 50% 50% 50% / 88% 88% 16% 16%',
        filter: `blur(${5 * blurMul}px)`, mixBlendMode: 'screen', opacity: op,
      }} />);
      out.push(<div key={'i' + key} style={{
        position: 'absolute', left: cx, top: ey - h * 0.7, width: w * 0.4, height: h * 0.7,
        marginLeft: -(w * 0.4) / 2, transformOrigin: '50% 100%',
        transform: `translateX(${lean * 1.2}px)`,
        background: 'radial-gradient(ellipse 50% 56% at 50% 100%, #ffffff 0%, #fff0b0 30%, #ffb43c 62%, transparent 86%)',
        borderRadius: '50% 50% 50% 50% / 90% 90% 12% 12%',
        filter: `blur(${2.4 * blurMul}px)`, mixBlendMode: 'screen', opacity: op * 0.95,
      }} />);
    };

    for (let k = 0; k < TONGUES.length; k++) tongue(TONGUES[k], 'T' + k, 1, 1.15);
    for (let k = 0; k < LICKS.length; k++) tongue(LICKS[k], 'L' + k, 1, 0.7);

    return <div style={{ position: 'absolute', inset: 0 }}>{out}</div>;
  }

  // ── rising sparks (world space) ────────────────────────────────────────────
  function Sparks({ t }) {
    const cl = clamp;
    const out = [];
    for (let k = 0; k < SPARKS.length; k++) {
      const s = SPARKS[k];
      const age = t - s.birth;
      if (age < 0 || age > s.life) continue;
      const startY = PY + cl(burnFront(s.birth), 4, PH);
      const startX = PX + s.u * PW + edgeOffset(s.u, s.birth);
      const y = startY - s.vy * age - s.acc * age * age;
      if (y < -50) continue;
      const x = startX + Math.sin(age * s.freq + s.phase) * s.drift + s.side * age;
      const lifeT = age / s.life;
      const op = cl(age / 0.08, 0, 1) * (1 - lifeT) * cl(flameEnv(s.birth) + 0.25, 0, 1) * cl((9.7 - t) / 0.9, 0, 1);
      const sz = s.size * (1 - 0.4 * lifeT);
      const light = lerp(78, 54, lifeT);
      out.push(<div key={k} style={{
        position: 'absolute', left: x, top: y, width: sz, height: sz,
        marginLeft: -sz / 2, marginTop: -sz / 2, borderRadius: '50%',
        background: `radial-gradient(circle, hsla(${s.hue},100%,${light}%,1) 0%, hsla(${s.hue - 8},100%,50%,0.7) 45%, transparent 72%)`,
        boxShadow: `0 0 ${sz * 1.8}px hsla(${s.hue},100%,60%,0.85)`,
        mixBlendMode: 'screen', opacity: op,
      }} />);
    }
    return <div style={{ position: 'absolute', inset: 0 }}>{out}</div>;
  }

  // ── drifting ash flecks (the paper, gone to the universe) ──────────────────
  function Ash({ t }) {
    const cl = clamp;
    const out = [];
    for (let k = 0; k < ASH.length; k++) {
      const s = ASH[k];
      const age = t - s.birth;
      if (age < 0 || age > s.life) continue;
      const startY = PY + cl(burnFront(s.birth), 0, PH);
      const startX = PX + s.u * PW;
      const y = startY - s.vy * age - 6 * age * age;
      if (y < -60) continue;
      const x = startX + Math.sin(age * s.freq + s.phase) * s.drift + s.side * age;
      const lifeT = age / s.life;
      const op = cl(age / 0.2, 0, 1) * (1 - lifeT) * 0.62 * cl((9.7 - t) / 0.9, 0, 1);
      const sz = s.size;
      const rot = s.rot + s.rots * age;
      out.push(<div key={k} style={{
        position: 'absolute', left: x, top: y, width: sz, height: sz * 0.7,
        marginLeft: -sz / 2, marginTop: -sz / 2,
        background: `rgba(${s.g | 0},${(s.g * 0.9) | 0},${(s.g * 0.8) | 0},0.9)`,
        borderRadius: '40% 60% 55% 45%',
        transform: `rotate(${rot}deg)`,
        boxShadow: '0 0 4px rgba(0,0,0,0.4)',
        opacity: op,
      }} />);
    }
    return <div style={{ position: 'absolute', inset: 0 }}>{out}</div>;
  }

  // ── soft smoke plumes ──────────────────────────────────────────────────────
  function Smoke({ t }) {
    const cl = clamp;
    const out = [];
    for (let k = 0; k < SMOKE.length; k++) {
      const s = SMOKE[k];
      const age = t - s.birth;
      if (age < 0 || age > s.life) continue;
      const startY = PY + cl(burnFront(s.birth), -40, PH);
      const y = startY - s.vy * age;
      const x = PX + s.x * PW + Math.sin(age * 0.7 + s.ph) * s.drift;
      const lifeT = age / s.life;
      const sz = s.size * (0.6 + 0.8 * lifeT);
      const op = cl(age / 0.6, 0, 1) * (1 - lifeT) * 0.16 * cl((9.7 - t) / 0.9, 0, 1);
      out.push(<div key={k} style={{
        position: 'absolute', left: x, top: y, width: sz, height: sz,
        marginLeft: -sz / 2, marginTop: -sz / 2, borderRadius: '50%',
        background: 'radial-gradient(circle, rgba(150,140,128,0.9), rgba(120,110,100,0.4) 45%, transparent 72%)',
        filter: 'blur(26px)', opacity: op,
      }} />);
    }
    return <div style={{ position: 'absolute', inset: 0 }}>{out}</div>;
  }

  function Scene({ t, items, showWishes }) {

    // Camera is locked off — the paper never moves. Only fire/char/embers/smoke/ash move.
    return (
      <div style={{ position: 'absolute', inset: 0, overflow: 'hidden', background: 'transparent' }}>
        {/* paper + glow + char-rim + flames share the fixed, slightly-tilted paper frame */}
        <div style={{
          position: 'absolute', left: PX, top: PY, width: PW, height: PH,
          transform: 'rotate(-1deg)', transformOrigin: '50% 50%',
        }}>
          <Paper t={t} items={items} showWishes={showWishes} />
          <FireGlow t={t} />
          <EmberRim t={t} />
          <Flames t={t} />
        </div>

        <Smoke t={t} />
        <Sparks t={t} />
        <Ash t={t} />
      </div>
    );
  }


  function ZettelBurn({ items, showWishes = true, onDone, duration = 8.4 }) {
    const [t, setT] = React.useState(0);
    const wrapRef = React.useRef(null);
    const [scale, setScale] = React.useState(0.32);
    const doneRef = React.useRef(false);
    React.useEffect(() => {
      let raf, start = performance.now(), lastDraw = 0;
      const FRAME = 1000 / 30; // auf ~30fps drosseln — bei Feuer optisch identisch, halbe Rechenlast
      const tick = (now) => {
        const tt = (now - start) / 1000;
        if (now - lastDraw >= FRAME) { lastDraw = now; setT(tt); }
        if (tt >= duration) { if (!doneRef.current) { doneRef.current = true; onDone && onDone(); } return; }
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
      return () => cancelAnimationFrame(raf);
    }, []);
    React.useEffect(() => {
      const fit = () => { if (wrapRef.current) setScale(wrapRef.current.clientWidth / W); };
      fit(); window.addEventListener('resize', fit); return () => window.removeEventListener('resize', fit);
    }, []);
    return (
      <div ref={wrapRef} style={{ position: 'relative', width: '100%', aspectRatio: `${W} / ${H}`, overflow: 'hidden', background: 'transparent' }}>
        <div style={{ position: 'absolute', top: 0, left: 0, width: W, height: H, transform: `scale(${scale})`, transformOrigin: 'top left' }}>
          <Scene t={t} items={items} showWishes={showWishes} />
        </div>
      </div>
    );
  }
  return ZettelBurn;
})();



export default function LenormandApp() {
  const gold = "#c8a96e";
  const [lightMode, setLightMode] = React.useState(() => localStorage.getItem("lenni_theme") !== "dark");
  const toggleTheme = () => setLightMode(m => { localStorage.setItem("lenni_theme", !m ? "light" : "dark"); return !m; });
  const appBg = lightMode
    ? "linear-gradient(to bottom, #fdf5e0 0%, #e8f0a0 35%, #d8b8e8 70%, #a050b0 100%)"
    : "linear-gradient(160deg,#080512,#0f0a1a,#0a0810)";
  const appColor = lightMode ? "#2a0850" : "#f0e8d8";
  const [view, setView] = useState(() => sessionStorage.getItem("lenni_view") || "liesmich");

  // Auth
  const [session, setSession] = React.useState(() => supabase.auth.getSession());
  const [authLoading, setAuthLoading] = React.useState(false);

  // Simple instant check - no async verification
  React.useEffect(() => {
    const hash = window.location.hash;
    if (hash && hash.includes("access_token")) {
      const params = new URLSearchParams(hash.replace("#","?"));
      const access_token = params.get("access_token");
      const refresh_token = params.get("refresh_token");
      if (access_token) {
        const sessionData = {access_token, refresh_token};
        localStorage.setItem("sb_session", JSON.stringify(sessionData));
        setSession(sessionData);
        window.location.hash = "";
      }
    }
  }, []);

  // Direkter Link zur Community/Forum-Seite, z.B. für die YouTube-Videobeschreibung:
  // https://lenormand-app-tau.vercel.app/#community
  // Direkter Link zu EINEM bestimmten Beitrag, z.B. für eine Mitmach-Mittwoch-Antwort:
  // https://lenormand-app-tau.vercel.app/#post-<beitrags-id>
  React.useEffect(() => {
    const hash = window.location.hash;
    if (hash === "#community") {
      setView("forum");
      setForumView("liste");
      window.history.replaceState(null, "", window.location.pathname + window.location.search);
    } else if (hash.startsWith("#post-")) {
      loadAndOpenPostById(hash.slice("#post-".length));
      window.history.replaceState(null, "", window.location.pathname + window.location.search);
    }
  }, []);

  // view bei jeder Änderung in sessionStorage sichern, damit ein Reload die Person
  // auf derselben Seite lässt (dailyMode/communityMode werden weiter unten gesichert,
  // direkt nachdem sie deklariert sind).
  React.useEffect(() => { sessionStorage.setItem("lenni_view", view); }, [view]);

  // Token frisch halten — damit dich beim Schreiben (Writing!) nichts mehr ausloggt und
  // weiter gespeichert wird. Liest den refresh_token DIREKT aus dem localStorage (nicht über
  // getSession, das einen abgelaufenen access_token zwar nicht mehr löscht, aber null liefert),
  // erneuert proaktiv ~10 Min vor Ablauf, alle 3 Min, beim Start und bei jedem Tab-Fokus
  // (fängt den Fall ab, dass Laptop/Handy zwischendurch geschlafen haben).
  React.useEffect(() => {
    let stopped = false, busy = false;
    const readStored = () => { try { return JSON.parse(localStorage.getItem("sb_session") || "null"); } catch { return null; } };
    const secondsLeft = (s) => { try { return JSON.parse(atob(s.access_token.split('.')[1])).exp - Math.floor(Date.now() / 1000); } catch { return -1; } };
    const doRefresh = async (s) => {
      if (busy || !s?.refresh_token) return;
      busy = true;
      try {
        const r = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
          method: "POST", headers: { "apikey": SUPABASE_KEY, "Content-Type": "application/json" },
          body: JSON.stringify({ refresh_token: s.refresh_token })
        });
        const data = await r.json();
        if (data.access_token) {
          localStorage.setItem("sb_session", JSON.stringify(data));
          if (!stopped) setSession(data);
        }
      } catch {} finally { busy = false; }
    };
    const maybeRefresh = () => {
      const s = readStored();
      if (!s?.refresh_token) return;
      if (secondsLeft(s) < 600) doRefresh(s); // < 10 Min Restlaufzeit (oder schon abgelaufen)
    };
    maybeRefresh(); // beim Start: falls im Hintergrund abgelaufen, sofort erneuern (auch Recovery nach Reload)
    const interval = setInterval(maybeRefresh, 3 * 60 * 1000);
    const onVisible = () => { if (document.visibilityState === "visible") maybeRefresh(); };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", maybeRefresh);
    return () => { stopped = true; clearInterval(interval); document.removeEventListener("visibilitychange", onVisible); window.removeEventListener("focus", maybeRefresh); };
  }, []);

  const [authView, setAuthView] = React.useState("login");
  // Account-Switcher (nur Admins): offen/zu, plus eigenes kleines Mini-Login-Formular
  // zum Hinzufügen eines weiteren Accounts, ohne die aktuelle Session zu verlieren.
  // Die Liste selbst liegt jetzt server-seitig (admin_known_accounts), darum hier als
  // State statt live bei jedem Render aus localStorage zu lesen.
  const [switcherOpen, setSwitcherOpen] = React.useState(false);
  const [switcherAddOpen, setSwitcherAddOpen] = React.useState(false);
  const [switcherMsg, setSwitcherMsg] = React.useState("");
  const [switcherAccounts, setSwitcherAccounts] = React.useState([]);
  const [switcherLoading, setSwitcherLoading] = React.useState(false);
  const [switcherSwitching, setSwitcherSwitching] = React.useState(null); // welcher Account wird gerade gewechselt
  // Ob auf diesem Gerät ein "Heimat-Admin"-Marker liegt — also ob man gerade in einem
  // Test-Account ist, von dem aus man zu einem Admin-Account zurückwechseln kann.
  const [hasHomeAdmin, setHasHomeAdmin] = React.useState(() => !!localStorage.getItem("lenni_home_admin_session"));
  const [switchingBackToAdmin, setSwitchingBackToAdmin] = React.useState(false);
  const [authEmail, setAuthEmail] = React.useState("");
  const [authPassword, setAuthPassword] = React.useState("");
  const [authName, setAuthName] = React.useState("");
  const [authMsg, setAuthMsg] = React.useState("");

  const handleLogin = async () => {
    setAuthMsg(""); 
    const data = await supabase.auth.signInWithPassword({email: authEmail, password: authPassword});
    if (data.access_token) {
      setSession(data);
      // Für den Account-Switcher merken — ownerId direkt aus dem frisch erhaltenen
      // Token lesen (nicht über getUserId(), das wäre hier zwar auch korrekt, aber
      // so ist es unabhängig von Timing/Reihenfolge garantiert richtig).
      try {
        const payload = JSON.parse(atob(data.access_token.split('.')[1]));
        rememberAccount(data, payload.sub, data.access_token);
      } catch {}
      // Falls der Login ausgelöst wurde, weil jemand im Forum etwas schreiben oder eine
      // geschützte Kategorie betreten wollte, direkt wieder dort hin springen
      if (view === "forum-login-noetig") {
        setView("forum");
        if (forumActiveCategory) { setForumView("kategorie"); loadForumPosts(forumActiveCategory.id); }
        else { setForumView("liste"); }
      }
    }
    else { setAuthMsg(data.error_description || data.msg || "E-Mail oder Passwort falsch"); }
  };

  // Loggt einen WEITEREN Account ein und merkt ihn sich, OHNE die gerade aktive Session
  // zu verändern — wichtig, damit man als Admin nicht erst sich selbst ausloggen muss,
  // nur um einen neuen Test-Account in die Switcher-Liste aufzunehmen.
  // Lädt die eigene Account-Switcher-Liste vom Server neu — wird beim Öffnen des
  // Switchers aufgerufen, damit garantiert die aktuelle, geräteübergreifende Liste
  // angezeigt wird (nicht ein evtl. veralteter lokaler Stand).
  const loadSwitcherAccounts = async () => {
    setSwitcherLoading(true);
    const list = await getKnownAccounts(getUserId(), getAccessToken());
    setSwitcherAccounts(list);
    setSwitcherLoading(false);
  };

  const handleBackToAdmin = async () => {
    setSwitchingBackToAdmin(true);
    const ok = await switchBackToHomeAdmin();
    if (!ok) setSwitchingBackToAdmin(false);
    // bei Erfolg lädt switchBackToHomeAdmin() die Seite ohnehin neu
  };

  const handleSwitcherAddAccount = async (email, password) => {
    setSwitcherMsg("");
    if (!email || !password) { setSwitcherMsg("Bitte E-Mail und Passwort eingeben"); return; }
    // Bewusst die isolierte Login-Funktion — die rührt localStorage["sb_session"] zu
    // keinem Zeitpunkt an, damit garantiert kein anderer App-Teil zwischenzeitlich mit
    // der ID des neu hinzugefügten Accounts arbeitet (siehe Kommentar an deren Definition).
    const data = await loginWithoutTouchingSession(email, password);
    if (data.access_token) {
      // Wichtig: ownerId ist die EIGENE ID (die gerade aktiv eingeloggte Admin-Person),
      // nicht die des frisch hinzugefügten Accounts — sonst würde der Eintrag in der
      // Liste des Test-Accounts landen statt in der eigenen.
      await rememberAccount(data, getUserId(), getAccessToken());
      setSwitcherAddOpen(false);
      setSwitcherMsg("✓ Account hinzugefügt");
      loadSwitcherAccounts();
      setTimeout(() => setSwitcherMsg(""), 2000);
    } else {
      setSwitcherMsg(data.error_description || data.msg || "E-Mail oder Passwort falsch");
    }
  };

  const handleRegister = async () => {
    setAuthMsg("");
    if (!authName.trim()) { setAuthMsg("Bitte gib einen Namen ein."); return; }
    const data = await supabase.auth.signUp({email: authEmail, password: authPassword});
    if (data.id || data.user) {
      const newUid = data.id || data.user?.id;
      // Namen direkt im Profil speichern, damit er z.B. im Forum als Anzeigename erscheinen kann.
      // Neuanmeldungen starten automatisch mit 14 Tagen Pro-Testphase, danach Rückstufung
      // auf "member" beim nächsten Login (siehe loadRole-Logik weiter unten).
      if (newUid) {
        const trialUntil = new Date(Date.now() + 14 * 86400000).toISOString();
        try {
          await fetch(`${SUPABASE_URL}/rest/v1/profiles`, {
            method: "POST",
            headers: { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json", "Prefer": "resolution=merge-duplicates" },
            body: JSON.stringify({ id: newUid, display_name: authName.trim(), role: "pro", pro_trial_until: trialUntil })
          });
        } catch {}
        // Als 🌱-Ereignis in den Aktivitäts-Stream legen, damit die Community
        // das neue Mitglied begrüßen (kommentieren) kann.
        try {
          await fetch(`${SUPABASE_URL}/rest/v1/activity_events`, {
            method: "POST",
            headers: { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json", "Prefer": "return=minimal" },
            body: JSON.stringify({ user_id: newUid, display_name: authName.trim(), kind: "member", payload: {} })
          });
        } catch {}
      }
      setAuthMsg("✉️ Fast geschafft! Bitte bestätige deine E-Mail — dann kannst du dich einloggen."); setAuthView("login");
    }
    else { setAuthMsg(data.error_description || data.msg || "Fehler bei der Registrierung"); }
  };

  const handleLogout = () => {
    supabase.auth.signOut();
    setSession(null);
    setAuthEmail(""); setAuthPassword(""); setAuthMsg("");
  };

  // Login Screen
  // Login-Screen als JSX-Variable statt frühem return — wird erst NACH allen Hooks
  // ausgewertet, sonst springt React zwischen unterschiedlich vielen Hooks pro Render
  // (das war die Ursache des leeren Bildschirms nach dem Einloggen, der erst durch
  // Neuladen der Seite verschwand).
  const loginScreen = (
    <div style={{ minHeight:"100vh", background:"linear-gradient(160deg,#080512,#0f0a1a,#0a0810)", fontFamily:"Georgia,serif", color:"#f0e8d8", display:"flex", alignItems:"stretch" }}>

      {/* Links: Dekorativ */}
      <div style={{ flex:"1 1 50%", position:"relative", overflow:"hidden", minHeight:"100vh" }}>
        <img src="https://static.wixstatic.com/media/3da789_1441028e13414bc39894dc502787a5e4~mv2.jpg"
          alt="Lenormandia" style={{ width:"100%", height:"100%", objectFit:"cover", objectPosition:"center top" }} />
      </div>

      {/* Rechts: Login-Formular */}
      <div style={{ flex:"0 0 min(100%, 400px)", display:"flex", alignItems:"center", justifyContent:"center", padding:"40px 32px", background:"#3a1060" }}>
        <div style={{ width:"100%", maxWidth:360 }}>
          <button onClick={() => { if (view === "forum-login-noetig") { setView("forum"); } else { const freie = ["liesmich","fragmich","forum"]; if (!freie.includes(view)) setView("liesmich"); } }}
            style={{ background:"transparent", border:"none", color:"#d4c4a0", cursor:"pointer", fontSize:12, marginBottom:18, padding:0, fontFamily:"Georgia,serif" }}>
            ← zurück zur App
          </button>
          <div style={{ textAlign:"center", marginBottom:28 }}>
            <div style={{ fontSize:28, marginBottom:6 }}>🐍</div>
            <div style={{ fontSize:20, color:"#f0e8d8", fontWeight:"normal", marginBottom:2, letterSpacing:1 }}>Willkommen in</div>
            <div style={{ fontSize:32, color:"#c8a96e", fontWeight:"normal", letterSpacing:4, marginBottom:6 }}>Lenormandia</div>
            <div style={{ fontSize:11, color:"#d4c4a0", fontStyle:"italic" }}>Melde dich an um fortzufahren</div>
          </div>

          <div style={{ display:"flex", gap:8, marginBottom:24, justifyContent:"center" }}>
            {[["login","Einloggen"],["register","Registrieren"]].map(([v,l]) => (
              <button key={v} onClick={() => { setAuthView(v); setAuthMsg(""); }}
                style={{ padding:"6px 18px", borderRadius:6, border:`1px solid ${authView===v?gold:"rgba(200,169,110,0.2)"}`, background:authView===v?"rgba(200,169,110,0.12)":"transparent", color:authView===v?gold:"#7a6040", cursor:"pointer", fontSize:12, fontFamily:"Georgia,serif" }}>
                {l}
              </button>
            ))}
          </div>

          {authView === "register" && (
            <div style={{ marginBottom:14 }}>
              <div style={{ fontSize:10, color:lightMode?"#2a0850":"#7a6040", marginBottom:5 }}>Name</div>
              <input type="text" value={authName} onChange={e => setAuthName(e.target.value)}
                placeholder="Wie du im Forum heißen möchtest"
                style={{ width:"100%", padding:"10px 12px", background:"rgba(200,169,110,0.04)", border:`1px solid ${lightMode?"rgba(80,30,120,0.3)":"rgba(200,169,110,0.2)"}`, borderRadius:7, color:lightMode?"#2a0850":"#d4c4a0", fontFamily:"Georgia,serif", fontSize:13, outline:"none", boxSizing:"border-box" }} />
            </div>
          )}

          <div style={{ marginBottom:14 }}>
            <div style={{ fontSize:10, color:"#d4c4a0", marginBottom:5 }}>E-Mail</div>
            <input type="email" value={authEmail} onChange={e => setAuthEmail(e.target.value)}
              placeholder="deine@email.de"
              style={{ width:"100%", padding:"10px 12px", background:"rgba(200,169,110,0.08)", border:"1px solid rgba(200,169,110,0.2)", borderRadius:7, color:"#f0e8d8", fontFamily:"Georgia,serif", fontSize:13, outline:"none", boxSizing:"border-box" }} />
          </div>

          <div style={{ marginBottom:20 }}>
            <div style={{ fontSize:10, color:"#d4c4a0", marginBottom:5 }}>Passwort</div>
            <input type="password" value={authPassword} onChange={e => setAuthPassword(e.target.value)}
              onKeyDown={e => e.key==="Enter" && (authView==="login" ? handleLogin() : handleRegister())}
              placeholder="••••••••"
              style={{ width:"100%", padding:"10px 12px", background:"rgba(200,169,110,0.08)", border:"1px solid rgba(200,169,110,0.2)", borderRadius:7, color:"#f0e8d8", fontFamily:"Georgia,serif", fontSize:13, outline:"none", boxSizing:"border-box" }} />
          </div>

          {authMsg && <div style={{ fontSize:12, color: authMsg.startsWith("✉️") ? "#90d090" : "#c87a6a", marginBottom:14, textAlign:"center", lineHeight:1.6 }}>{authMsg}</div>}

          <button onClick={authView==="login" ? handleLogin : handleRegister} disabled={authLoading}
            style={{ width:"100%", padding:"12px", background:"rgba(200,169,110,0.12)", border:`1px solid ${gold}`, color:gold, borderRadius:8, cursor:"pointer", fontSize:14, fontFamily:"Georgia,serif", letterSpacing:1, opacity:authLoading?0.6:1 }}>
            {authLoading ? "…" : authView==="login" ? "✨ Einloggen" : "✨ Registrieren"}
          </button>

          {authView==="register" && (
            <div style={{ textAlign:"center", marginTop:16, fontSize:10, color:"#c0a880", lineHeight:1.7 }}>
              Du bekommst eine Bestätigungs-E-Mail.<br/>
              Bitte klicke den Link darin — dann kannst du dich einloggen.<br/><br/>
              <span style={{ color:"#a09070", fontStyle:"italic" }}>
                Hinweis: Die Mail kommt von einer Supabase-Adresse — das ist unser technischer Versanddienst im Hintergrund und völlig okay. 💛
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  );


  const getTodayKey = () => new Date().toISOString().slice(0,10);
  const formatDate = (key) => {
    const [y,m,d] = key.split("-");
    return `${d}.${m}.${y}`;
  };
  const getDeviceId = () => {
    let id = localStorage.getItem("lenni_device_id");
    if (!id) {
      id = Math.floor(Math.random() * 999999).toString();
      localStorage.setItem("lenni_device_id", id);
    }
    return parseInt(id);
  };
  // Lädt alle Tagebuch-Einträge der eingeloggten Person aus Supabase — als Objekt
  // {dateKey: {gedanken, reflexionen, resumee}}, genau in der Form, die der Rest der App
  // erwartet, damit möglichst wenig anderswo geändert werden musste.
  const loadTagebuch = async (uid) => {
    if (!uid) return {};
    try {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/tagebuch_entries?user_id=eq.${uid}&select=date_key,gedanken,reflexionen,resumee`, {headers: dbHeaders()});
      const data = await r.json();
      if (!Array.isArray(data)) return {};
      const out = {};
      data.forEach(e => { out[e.date_key] = { gedanken: e.gedanken || "", reflexionen: e.reflexionen || "", resumee: e.resumee || "" }; });
      return out;
    } catch { return {}; }
  };
  // Speichert/aktualisiert genau EINEN Tag — per Upsert (merge-duplicates auf die
  // UNIQUE(user_id, date_key)-Kombination), damit sowohl Neuanlage als auch Update mit
  // demselben Aufruf funktionieren.
  const saveTagebuchEntry = async (uid, dateKey, entry) => {
    if (!uid) return;
    try {
      await fetch(`${SUPABASE_URL}/rest/v1/tagebuch_entries`, {
        method: "POST", headers: {...dbHeaders(), "Prefer": "resolution=merge-duplicates"},
        body: JSON.stringify({ user_id: uid, date_key: dateKey, gedanken: entry.gedanken || "", reflexionen: entry.reflexionen || "", resumee: entry.resumee || "", updated_at: new Date().toISOString() })
      });
    } catch {}
  };
  const getDailyCard = (klientSeed, dateKey) => {
    const d = dateKey ? new Date(dateKey + "T12:00:00") : new Date();
    const dateSeed = d.getFullYear()*10000 + (d.getMonth()+1)*100 + d.getDate();
    const baseSeed = klientSeed !== undefined ? klientSeed : (userSeed || getDeviceId());
    const seed = dateSeed + baseSeed;
    const keys = Object.keys(CARDS);
    const c1 = parseInt(keys[seed % keys.length]);
    const c2 = parseInt(keys[(seed * 7 + 13) % keys.length]);
    const card2 = c2 === c1 ? parseInt(keys[(seed * 7 + 14) % keys.length]) : c2;
    const lo = Math.min(c1, card2), hi = Math.max(c1, card2);
    return {c1, c2: card2, comboKey: `${lo}-${hi}`};
  };

  // Klient-State
  const [tagebuchView, setTagebuchView] = React.useState("tagebuch");
  const [dailyMode, setDailyMode] = React.useState(() => sessionStorage.getItem("lenni_dailyMode") || "tagebuch");
  const [communityMode, setCommunityMode] = React.useState(() => sessionStorage.getItem("lenni_communityMode") || "forum");
  React.useEffect(() => { sessionStorage.setItem("lenni_dailyMode", dailyMode); }, [dailyMode]);
  React.useEffect(() => { sessionStorage.setItem("lenni_communityMode", communityMode); }, [communityMode]);
  const [writingView, setWritingView] = React.useState("projekt");
  const [writingProjekt, setWritingProjekt] = React.useState("");
  const [writingBemerkung, setWritingBemerkung] = React.useState("");
  const [writingHook, setWritingHook] = React.useState("");
  const [writingCards, setWritingCards] = React.useState(null);
  const [writingNotes, setWritingNotes] = React.useState({});
  // Refs, die immer den allerneuesten Stand halten — wichtig, weil saveProject() über einen
  // setTimeout-Callback aufgerufen wird und sonst einen veralteten (Closure-)Stand sehen könnte,
  // z.B. wenn der Timer feuert, bevor der State-Update durch onChange "angekommen" ist.
  const writingNotesRef = React.useRef(writingNotes);
  const writingProjektRef = React.useRef(writingProjekt);
  const writingBemerkungRef = React.useRef(writingBemerkung);
  const writingHookRef = React.useRef(writingHook);
  React.useEffect(() => { writingNotesRef.current = writingNotes; }, [writingNotes]);
  React.useEffect(() => { writingProjektRef.current = writingProjekt; }, [writingProjekt]);
  React.useEffect(() => { writingBemerkungRef.current = writingBemerkung; }, [writingBemerkung]);
  React.useEffect(() => { writingHookRef.current = writingHook; }, [writingHook]);
  const [writingSessionId, setWritingSessionId] = React.useState(null);
  const [writingProjectId, setWritingProjectId] = React.useState(null);
  const [savedProjects, setSavedProjects] = React.useState([]);
  const [showProjects, setShowProjects] = React.useState(false);
  const [folders, setFolders] = React.useState([]);
  const [selectedFolder, setSelectedFolder] = React.useState(null);
  const [showProjectList, setShowProjectList] = React.useState(false);
  const [newFolderName, setNewFolderName] = React.useState("");
  const [showNewFolder, setShowNewFolder] = React.useState(false);
  const [activeWritingPos, setActiveWritingPos] = React.useState(null);
  const [showWritingMatrix, setShowWritingMatrix] = React.useState(true);
  const [textTemplates, setTextTemplates] = React.useState([]);
  const [showSaveTemplate, setShowSaveTemplate] = React.useState(false);
  const [newTemplateName, setNewTemplateName] = React.useState("");
  const [showLoadTemplate, setShowLoadTemplate] = React.useState(false);
  const [selectedTemplate, setSelectedTemplate] = React.useState(null);
  const [collapsedFields, setCollapsedFields] = React.useState({});

  const writingTimer = React.useRef(null);
  const writingIsSaving = React.useRef(false);
  const writingPendingResave = React.useRef(false);
  const [writingSaveStatus, setWritingSaveStatus] = React.useState("idle"); // idle | saving | saved | error
  // Debounce-Timer fürs Tagebuch (Tageskarten-Notizen) — gleiche Idee wie bei Writing:
  // nicht bei jedem Tastendruck sofort speichern, sondern erst wenn 1,5s Ruhe ist.
  const tagebuchTimer = React.useRef(null);
  const [writingSaveError, setWritingSaveError] = React.useState("");

  // Ordner, Projekte und Textvorlagen laden — eigenständige Funktion, damit sie auch
  // nach dem Anlegen/Ändern einer Vorlage erneut aufgerufen werden kann, um sicherzugehen,
  // dass die Liste wirklich den aktuellen Datenbankstand zeigt.
  const loadAllWritingData = async () => {
    const uid = getUserId();
    if (!uid) return;
    try {
      const [fR, pR, tR] = await Promise.all([
        fetch(`${SUPABASE_URL}/rest/v1/writing_project_folders?user_id=eq.${uid}&order=created_at.asc`, {headers: dbHeaders()}),
        fetch(`${SUPABASE_URL}/rest/v1/writing_projects?user_id=eq.${uid}&order=updated_at.desc`, {headers: dbHeaders()}),
        fetch(`${SUPABASE_URL}/rest/v1/writing_text_templates?user_id=eq.${uid}&order=created_at.asc`, {headers: dbHeaders()})
      ]);
      const fData = await fR.json();
      const pData = await pR.json();
      const tData = await tR.json();
      if (Array.isArray(fData)) setFolders(fData);
      if (Array.isArray(pData)) setSavedProjects(pData);
      if (Array.isArray(tData)) setTextTemplates(tData);
      return tData;
    } catch {
      return null;
    }
  };

  React.useEffect(() => {
    loadAllWritingData();
  }, [session]);

  // ===== FORUM =====
  const [userRole, setUserRole] = React.useState(null);
  const [userSeed, setUserSeed] = React.useState(() => {
    // Sofort aus localStorage lesen falls Session schon da
    try {
      const s = JSON.parse(localStorage.getItem("sb_session")||"null");
      if (s && s.access_token) {
        const payload = JSON.parse(atob(s.access_token.split('.')[1]));
        const uid = payload.sub || "";
        return uid.split('').reduce((a, c) => a + c.charCodeAt(0), 0) * 137;
      }
    } catch {}
    return null;
  });
  const [userDisplayName, setUserDisplayName] = React.useState("");
  const [userBio, setUserBio] = React.useState("");
  const [userSignature, setUserSignature] = React.useState("");
  const [userBirthdate, setUserBirthdate] = React.useState("");
  const [userGender, setUserGender] = React.useState("");
  const [proTrialDaysLeft, setProTrialDaysLeft] = React.useState(null);
  const [profileEditing, setProfileEditing] = React.useState(false);
  const [profileSaveStatus, setProfileSaveStatus] = React.useState("");
  const [forumCategories, setForumCategories] = React.useState([]);
  const [forumView, setForumView] = React.useState("liste"); // "liste" | "kategorie" | "post" | "neu"
  // Aktivitäts-Stream als Startbild der Forum-Übersicht (Facebook-artiger Feed).
  const [forumStartTab, setForumStartTab] = React.useState("stream"); // "stream" | "kategorien"
  const [forumStream, setForumStream] = React.useState([]);
  const [forumStreamLoading, setForumStreamLoading] = React.useState(false);
  const [streamStatusText, setStreamStatusText] = React.useState("");
  const [forumStreamComments, setForumStreamComments] = React.useState({}); // eventId -> [comments]
  const [streamCommentDrafts, setStreamCommentDrafts] = React.useState({}); // eventId -> Textentwurf
  const [streamCommentsOpen, setStreamCommentsOpen] = React.useState({}); // eventId -> bool (Eingabe sichtbar)
  const [streamCommentReplyTo, setStreamCommentReplyTo] = React.useState({}); // eventId -> {id, name} Ziel-Kommentar (verschachtelt)
  const [streamLikeCounts, setStreamLikeCounts] = React.useState({}); // eventId -> Anzahl
  const [streamMyLikes, setStreamMyLikes] = React.useState({}); // eventId -> bool (ich habe geliked)
  const [streamReplyDrafts, setStreamReplyDrafts] = React.useState({}); // postId -> Antwort-Entwurf
  const [streamReplyTo, setStreamReplyTo] = React.useState({}); // postId -> {id, name} Ziel-Antwort (für verschachtelte Antworten)
  const [streamRepliesExpanded, setStreamRepliesExpanded] = React.useState({}); // postId -> alle Antworten zeigen
  const [streamPostExpanded, setStreamPostExpanded] = React.useState({}); // postId -> langer Beitragstext ausgeklappt
  const [showScrollTop, setShowScrollTop] = React.useState(false);
  React.useEffect(() => {
    const onScroll = () => setShowScrollTop(window.scrollY > 400);
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  const [forumActiveCategory, setForumActiveCategory] = React.useState(null);
  const [forumPosts, setForumPosts] = React.useState([]);
  // Kurse-Bereich: eigene States, gleiche Struktur wie Forum
  // Kategorie = Kurs, Beitrag = Lektion, Antworten = Fragen/Diskussion
  const [kurseCategories, setKurseCategories] = React.useState([]);
  const [kurseMerkliste, setKurseMerkliste] = React.useState(new Set()); // category_ids in "Meine Kurse"
  const [kurseView, setKurseView] = React.useState("liste");
  const [kurseActiveCategory, setKurseActiveCategory] = React.useState(null);
  const [kursePosts, setKursePosts] = React.useState([]);
  const [kurseActivePost, setKurseActivePost] = React.useState(null);
  const [forumReadPostIds, setForumReadPostIds] = React.useState(new Set());
  // Pro user_id: { role, createdAt, postCount } — für die kleine Profilkarte vor jedem Beitrag
  const [forumProfiles, setForumProfiles] = React.useState({});
  // Echte Forum-Statistik (alle Mitglieder, alle Beiträge inkl. Antworten, heute aktiv) —
  // wird zusammen mit den Kategorien in loadForumCategories() berechnet, damit dafür
  // keine zusätzlichen Requests nötig sind.
  const [forumStats, setForumStats] = React.useState({ totalMembers: 0, totalPosts: 0, activeToday: 0, newToday: 0 });
  const [forumActivePost, setForumActivePost] = React.useState(null);
  const [forumReplies, setForumReplies] = React.useState([]);
  // Sortierung der Top-Level-Antworten: "neueste" (Standard) oder "beliebteste" (nach Likes).
  // Unterantworten innerhalb eines Threads bleiben immer chronologisch (älteste zuerst),
  // damit ein Gesprächsverlauf nachvollziehbar bleibt.
  const [forumReplySort, setForumReplySort] = React.useState("neueste");
  // Wie viele Top-Level-Antworten aktuell sichtbar sind — wächst beim Scrollen.
  // Unterantworten zu bereits sichtbaren Top-Level-Antworten zählen nicht mit dazu,
  // damit kein Thread mitten drin abgeschnitten wird.
  const [forumRepliesVisibleCount, setForumRepliesVisibleCount] = React.useState(20);
  // userId -> true, für Antworten, die die aktuell eingeloggte Person bereits geliked hat
  const [forumMyLikes, setForumMyLikes] = React.useState({});
  // replyId -> Anzahl Likes
  const [forumLikeCounts, setForumLikeCounts] = React.useState({});
  // Gleiches Prinzip wie bei Antworten, nur für den Beitrag selbst (forum_post_likes)
  const [forumMyPostLike, setForumMyPostLike] = React.useState(false);
  const [forumPostLikeCount, setForumPostLikeCount] = React.useState(0);
  const [forumNewTitle, setForumNewTitle] = React.useState("");
  const [forumNewBody, setForumNewBody] = React.useState("");
  const [forumNewName, setForumNewName] = React.useState(""); // Anzeigename für Gäste
  const [forumReplyText, setForumReplyText] = React.useState("");
  // Wenn gesetzt: die nächste Antwort bezieht sich auf eine bestehende Antwort (verschachtelt),
  // statt direkt auf den Beitrag selbst.
  const [forumReplyToId, setForumReplyToId] = React.useState(null);
  // Welcher Beitrag/welche Antwort wird gerade bearbeitet (id) — der bearbeitete Text selbst
  // lebt lokal in InlineEditBox/InlinePostEditBox, nicht hier (siehe deren Definition oben
  // für die Begründung: stabiler Fokus beim Tippen).
  const [forumEditingPostId, setForumEditingPostId] = React.useState(null);
  // Kurzes "✓ kopiert"-Feedback nach Klick auf den Link-Button — zeigt die ID des
  // Beitrags, dessen Link gerade kopiert wurde, für ein paar Sekunden.
  const [linkCopiedPostId, setLinkCopiedPostId] = React.useState(null);
  const [forumEditingReplyId, setForumEditingReplyId] = React.useState(null);
  // Wenn gesetzt: zeigt die öffentliche Profilkarte dieser Person (statt der normalen
  // Forum-Ansicht). Enthält absichtlich keine E-Mail — die bleibt privat.
  const [viewedProfileId, setViewedProfileId] = React.useState(null);
  const [viewedProfileName, setViewedProfileName] = React.useState("");
  const [forumReplyToName, setForumReplyToName] = React.useState("");
  const [forumNewCatName, setForumNewCatName] = React.useState("");
  const [forumNewCatDescription, setForumNewCatDescription] = React.useState("");
  const [forumNewCatIcon, setForumNewCatIcon] = React.useState("💬");
  const [forumNewCatVisibility, setForumNewCatVisibility] = React.useState("member");
  const [forumNewCatGuestPost, setForumNewCatGuestPost] = React.useState(false);
  const [forumShowNewCat, setForumShowNewCat] = React.useState(false);
  const [kurseShowNewCat, setKurseShowNewCat] = React.useState(false);
  // Welche Kategorie wird gerade bearbeitet (id) — die Feldwerte selbst leben lokal in
  // der CategoryEditBox-Komponente, aus dem gleichen Grund wie bei InlineEditBox: stabiler
  // Fokus beim Tippen, unabhängig von Re-Renders der großen Hauptkomponente.
  const [forumEditingCategoryId, setForumEditingCategoryId] = React.useState(null);
  const [forumError, setForumError] = React.useState("");

  // Nutzerrolle + Anzeigename + Bio laden, sobald eingeloggt — ohne Login bleibt userRole bei null (= Gast)
  // Zusätzlich: falls eine Pro-Testphase abgelaufen ist, wird hier automatisch auf
  // "member" zurückgestuft (sowohl lokal als auch dauerhaft in der Datenbank).
  React.useEffect(() => {
    const loadRole = async () => {
      const uid = getUserId();
      if (!uid) { setUserRole(null); setUserSeed(null); setUserDisplayName(""); setUserBio(""); setUserSignature(""); setUserBirthdate(""); setUserGender(""); setProTrialDaysLeft(null); setTagebuchData({}); return; }
      // User-spezifischer Seed für Tageskarten
      setUserSeed(uid.split('').reduce((a, c) => a + c.charCodeAt(0), 0) * 137);
      try {
        const r = await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${uid}&select=role,display_name,bio,signature,birthdate,gender,pro_trial_until`, {headers: dbHeaders()});
        const data = await r.json();
        const profile = (data && data[0]) || {};
        let role = profile.role || "member";
        setUserDisplayName(profile.display_name || "");
        setUserBio(profile.bio || "");
        setUserSignature(profile.signature || "");
        setUserBirthdate(profile.birthdate || "");
        setUserGender(profile.gender || "");

        // Tagebuch-Einträge (Tageskarten-Notizen) laden — vorher nur lokal im Browser,
        // jetzt geräteübergreifend aus der Datenbank.
        loadTagebuch(uid).then(setTagebuchData);

        // Eigenes last_seen aktualisieren — läuft im Hintergrund, blockiert nichts in der UI.
        // Grundlage für die "Heute aktiv"-Statistik im Forum (zählt auch reines Einloggen,
        // nicht nur Beiträge/Antworten/Likes).
        fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${uid}`, {
          method: "PATCH", headers: {...dbHeaders(), "Prefer": "return=minimal"},
          body: JSON.stringify({ last_seen: new Date().toISOString() })
        }).catch(() => {});

        if (profile.pro_trial_until) {
          const msLeft = new Date(profile.pro_trial_until).getTime() - Date.now();
          if (msLeft <= 0) {
            // Testphase abgelaufen — dauerhaft zurückstufen, außer jemand wurde inzwischen
            // ohnehin schon zu Mod/Admin gemacht (das soll nicht überschrieben werden).
            setProTrialDaysLeft(null);
            if (role === "pro") {
              role = "member";
              try {
                await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${uid}`, {
                  method: "PATCH", headers: dbHeaders(), body: JSON.stringify({ role: "member", pro_trial_until: null })
                });
              } catch {}
            }
          } else {
            setProTrialDaysLeft(Math.ceil(msLeft / 86400000));
          }
        } else {
          setProTrialDaysLeft(null);
        }
        setUserRole(role);
      } catch { setUserRole("member"); }
    };
    loadRole();
  }, [session]);

  const loadForumCategories = async () => {
    try {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/forum_categories?section=eq.forum&order=sort_order.asc`, {headers: dbHeaders()});
      const cats = await r.json();
      if (!Array.isArray(cats)) return;
      // Schlanke Liste aller Posts holen (id + category_id + created_at + Ersteller), um pro
      // Kategorie Anzahl, letzte Aktivität UND ob es ungelesene Beiträge gibt zu berechnen,
      // ohne für jede Kategorie einen eigenen Request zu brauchen.
      const [pr, rr, mr, lr, sr] = await Promise.all([
        fetch(`${SUPABASE_URL}/rest/v1/forum_posts?select=id,category_id,created_at,user_id`, {headers: dbHeaders()}),
        fetch(`${SUPABASE_URL}/rest/v1/forum_replies?select=user_id,created_at`, {headers: dbHeaders()}),
        fetch(`${SUPABASE_URL}/rest/v1/profiles?select=id,created_at`, {headers: dbHeaders()}),
        fetch(`${SUPABASE_URL}/rest/v1/forum_reply_likes?select=user_id,created_at`, {headers: dbHeaders()}),
        fetch(`${SUPABASE_URL}/rest/v1/profiles?select=id,last_seen`, {headers: dbHeaders()}),
      ]);
      const posts = await pr.json();
      const replies = await rr.json();
      const allProfiles = await mr.json();
      const likes = await lr.json();
      const seenProfiles = await sr.json();
      const statsByCategory = {};
      const myUid = getUserId();
      const postCountByUser = {};
      if (Array.isArray(posts)) {
        posts.forEach(p => {
          const s = statsByCategory[p.category_id] || { count: 0, lastActivity: null, hasUnread: false };
          s.count += 1;
          if (!s.lastActivity || p.created_at > s.lastActivity) s.lastActivity = p.created_at;
          // Eigene Beiträge zählen nicht als "ungelesen" — man hat sie ja selbst geschrieben
          if (myUid && p.user_id !== myUid && !forumReadPostIds.has(p.id)) s.hasUnread = true;
          statsByCategory[p.category_id] = s;
          if (p.user_id) postCountByUser[p.user_id] = (postCountByUser[p.user_id] || 0) + 1;
        });
      }
      // Antworten (inkl. Unterantworten) gleichwertig mitzählen — aktive Diskussion
      // ist genauso viel wert wie das Eröffnen eines Beitrags.
      if (Array.isArray(replies)) {
        replies.forEach(r => {
          if (r.user_id) postCountByUser[r.user_id] = (postCountByUser[r.user_id] || 0) + 1;
        });
      }
      // Rolle + Mitglied-seit-Datum für alle Personen holen, die hier schon mal geschrieben
      // haben — für die kleine Profilkarte vor jedem Beitrag/jeder Antwort.
      const userIds = Object.keys(postCountByUser);
      if (userIds.length > 0) {
        try {
          const prf = await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=in.(${userIds.join(",")})&select=id,role,created_at,bio,display_name,signature,birthdate`, {headers: dbHeaders()});
          const profilesData = await prf.json();
          if (Array.isArray(profilesData)) {
            const profMap = {};
            profilesData.forEach(p => {
              profMap[p.id] = { role: p.role || "member", createdAt: p.created_at, postCount: postCountByUser[p.id] || 0, bio: p.bio || "", displayName: p.display_name || "", signature: p.signature || "", birthdate: p.birthdate || "" };
            });
            setForumProfiles(profMap);
          }
        } catch {}
      }
      const enriched = cats.map(c => ({
        ...c,
        postCount: statsByCategory[c.id]?.count || 0,
        lastActivity: statsByCategory[c.id]?.lastActivity || null,
        hasUnread: statsByCategory[c.id]?.hasUnread || false
      }));
      enriched.sort((a, b) => {
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
        if (a.pinned && b.pinned) return a.sort_order - b.sort_order;
        if (a.hasUnread !== b.hasUnread) return a.hasUnread ? -1 : 1;
        if (!a.lastActivity && !b.lastActivity) return a.sort_order - b.sort_order;
        if (!a.lastActivity) return 1;
        if (!b.lastActivity) return -1;
        return b.lastActivity.localeCompare(a.lastActivity);
      });
      setForumCategories(enriched);

      // Echte Statistik für die Zeile unter dem Forum: alle Mitglieder, alle Beiträge
      // (inkl. Antworten), und wer heute aktiv war — Beitrag, Antwort, Like ODER einfach
      // nur eingeloggt gewesen (last_seen), je nachdem was zuerst zutrifft.
      const cutoff = Date.now() - 24 * 60 * 60 * 1000;
      const activeUserIds = new Set();
      const isRecent = (iso) => iso && new Date(iso).getTime() >= cutoff;
      if (Array.isArray(posts)) posts.forEach(p => { if (p.user_id && isRecent(p.created_at)) activeUserIds.add(p.user_id); });
      if (Array.isArray(replies)) replies.forEach(r => { if (r.user_id && isRecent(r.created_at)) activeUserIds.add(r.user_id); });
      if (Array.isArray(likes)) likes.forEach(l => { if (l.user_id && isRecent(l.created_at)) activeUserIds.add(l.user_id); });
      if (Array.isArray(seenProfiles)) seenProfiles.forEach(p => { if (p.id && isRecent(p.last_seen)) activeUserIds.add(p.id); });

      const totalPosts = (Array.isArray(posts) ? posts.length : 0) + (Array.isArray(replies) ? replies.length : 0);
      const newToday = Array.isArray(allProfiles) ? allProfiles.filter(p => isRecent(p.created_at)).length : 0;
      setForumStats({
        totalMembers: Array.isArray(allProfiles) ? allProfiles.length : 0,
        totalPosts,
        activeToday: activeUserIds.size,
        newToday
      });
    } catch {}
  };

  // Kurse-Bereich: Kategorien laden (section=kurse), Sortierung nach sort_order —
  // Kurse sollen in der Reihenfolge erscheinen, in der du sie anlegt, nicht nach Aktivität.
  const loadKurseCategories = async () => {
    try {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/forum_categories?section=eq.kurse&order=sort_order.asc`, {headers: dbHeaders()});
      const cats = await r.json();
      if (!Array.isArray(cats)) return;
      // Lektionen-Anzahl pro Kurs berechnen
      const pr = await fetch(`${SUPABASE_URL}/rest/v1/forum_posts?select=id,category_id`, {headers: dbHeaders()});
      const posts = await pr.json();
      const countByCat = {};
      if (Array.isArray(posts)) posts.forEach(p => { countByCat[p.category_id] = (countByCat[p.category_id] || 0) + 1; });
      setKurseCategories(cats.map(c => ({ ...c, postCount: countByCat[c.id] || 0 })));
    } catch {}
  };

  // Kurse umsortieren (Admin): tauscht sort_order mit dem Nachbarn und speichert beide.
  const moveKurseCategory = async (catId, dir) => {
    const idx = kurseCategories.findIndex(c => c.id === catId);
    const swapIdx = dir === "up" ? idx - 1 : idx + 1;
    if (idx < 0 || swapIdx < 0 || swapIdx >= kurseCategories.length) return;
    const a = kurseCategories[idx], b = kurseCategories[swapIdx];
    const aOrder = (a.sort_order != null) ? a.sort_order : idx;
    const bOrder = (b.sort_order != null) ? b.sort_order : swapIdx;
    const newList = kurseCategories.map(c =>
      c.id === a.id ? { ...a, sort_order: bOrder } : c.id === b.id ? { ...b, sort_order: aOrder } : c
    ).sort((x, y) => ((x.sort_order != null ? x.sort_order : 0) - (y.sort_order != null ? y.sort_order : 0)));
    setKurseCategories(newList);
    try {
      await Promise.all([
        fetch(`${SUPABASE_URL}/rest/v1/forum_categories?id=eq.${a.id}`, { method:"PATCH", headers: dbHeaders(), body: JSON.stringify({ sort_order: bOrder }) }),
        fetch(`${SUPABASE_URL}/rest/v1/forum_categories?id=eq.${b.id}`, { method:"PATCH", headers: dbHeaders(), body: JSON.stringify({ sort_order: aOrder }) }),
      ]);
    } catch {}
  };

  // "Meine Kurse": Kurse, die man geöffnet (auto) oder per ★ angepinnt (manuell) hat.
  const loadKurseMerkliste = async () => {
    const uid = getUserId();
    if (!uid) { setKurseMerkliste(new Set()); return; }
    try {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/kurse_merkliste?user_id=eq.${uid}&select=category_id`, {headers: dbHeaders()});
      const data = await r.json();
      setKurseMerkliste(new Set(Array.isArray(data) ? data.map(x => x.category_id) : []));
    } catch {}
  };
  const addKurseMerk = async (catId) => {
    const uid = getUserId();
    if (!uid || kurseMerkliste.has(catId)) return;
    setKurseMerkliste(prev => new Set(prev).add(catId));
    try {
      await fetch(`${SUPABASE_URL}/rest/v1/kurse_merkliste`, {
        method:"POST", headers:{...dbHeaders(), "Prefer":"resolution=merge-duplicates"},
        body: JSON.stringify({ user_id: uid, category_id: catId })
      });
    } catch {}
  };
  const toggleKurseMerk = async (catId) => {
    const uid = getUserId();
    if (!uid) return;
    if (kurseMerkliste.has(catId)) {
      setKurseMerkliste(prev => { const n = new Set(prev); n.delete(catId); return n; });
      try { await fetch(`${SUPABASE_URL}/rest/v1/kurse_merkliste?user_id=eq.${uid}&category_id=eq.${catId}`, {method:"DELETE", headers:dbHeaders()}); } catch {}
    } else {
      addKurseMerk(catId);
    }
  };

  const loadKursePosts = async (categoryId) => {
    try {
      // Lektionen in fester Reihenfolge — älteste zuerst, damit Lektion 1 oben steht
      const r = await fetch(`${SUPABASE_URL}/rest/v1/forum_posts?category_id=eq.${categoryId}&order=created_at.asc`, {headers: dbHeaders()});
      const data = await r.json();
      if (Array.isArray(data)) setKursePosts(data);
    } catch {}
  };

  React.useEffect(() => {
    loadForumCategories();
    loadKurseCategories();
    loadKurseMerkliste();
  }, [forumReadPostIds, session]);

  const loadForumPosts = async (categoryId) => {
    try {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/forum_posts?category_id=eq.${categoryId}&order=pinned.desc,created_at.desc`, {headers: dbHeaders()});
      const data = await r.json();
      if (Array.isArray(data)) setForumPosts(data);
    } catch {}
  };

  // Relative Zeitangabe für den Stream: "gerade eben", "vor 5 Min", "vor 3 Std", "vor 2 Tagen".
  const streamTimeAgo = (iso) => {
    if (!iso) return "";
    const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return "gerade eben";
    const m = Math.floor(s / 60); if (m < 60) return `vor ${m} Min`;
    const h = Math.floor(m / 60); if (h < 24) return `vor ${h} Std`;
    const d = Math.floor(h / 24); if (d < 7) return `vor ${d} ${d === 1 ? "Tag" : "Tagen"}`;
    const w = Math.floor(d / 7); if (w < 5) return `vor ${w} ${w === 1 ? "Woche" : "Wochen"}`;
    return new Date(iso).toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" });
  };

  // Baut den Aktivitäts-Stream aus vorhandenen Tabellen (Beiträge, Antworten, Likes,
  // neue Mitglieder) plus activity_events (Quiz-Highscores). Keine Duplizierung —
  // es wird nur gelesen und clientseitig nach Zeit gemischt.
  const loadForumStream = async () => {
    setForumStreamLoading(true);
    const q = (t, extra) => fetch(`${SUPABASE_URL}/rest/v1/${t}?${extra}`, { headers: dbHeaders(), cache: "no-store" }).then(r => r.json()).catch(() => []);
    try {
      const [posts, replies, events, cats] = await Promise.all([
        q("forum_posts", "select=id,title,body,display_name,user_id,category_id,created_at,matrix_data&order=created_at.desc&limit=25"),
        q("forum_replies", "select=id,post_id,body,display_name,user_id,created_at,reply_to_id&order=created_at.desc&limit=60"),
        q("activity_events", "select=id,user_id,display_name,kind,payload,created_at&order=created_at.desc&limit=20"),
        q("forum_categories", "select=id,name,icon,section"),
      ]);
      const arr = x => Array.isArray(x) ? x : [];
      // Kategorien frisch mitladen — sonst fallen manchmal Emojis raus (Timing-Race mit
      // dem State), und die Section brauchen wir, um Kurs-Inhalte aus dem Stream zu filtern.
      const catById = {}; arr(cats).forEach(c => { catById[c.id] = c; });
      const kurseCatIds = new Set(arr(cats).filter(c => c.section === "kurse").map(c => c.id));
      const isKursePost = p => p && kurseCatIds.has(p.category_id);
      const postById = {};
      arr(posts).filter(p => !isKursePost(p)).forEach(p => { postById[p.id] = p; });
      // Beiträge, die durch eine neue Antwort "hochgespült" werden (Bumping), aber nicht
      // unter den 25 neuesten stecken, gezielt nachladen — so steigt auch ein 3 Wochen
      // alter Beitrag wieder nach oben, wenn jemand darunter antwortet.
      const missingPostIds = [...new Set(arr(replies).map(r => r.post_id).filter(id => id && !postById[id]))];
      if (missingPostIds.length) arr(await q("forum_posts", `id=in.(${missingPostIds.join(",")})&select=id,title,body,display_name,user_id,category_id,created_at,matrix_data`)).filter(p => !isKursePost(p)).forEach(p => { postById[p.id] = p; });
      // Antworten pro Beitrag gruppieren (älteste zuerst für die Anzeige)
      const repliesByPost = {};
      arr(replies).slice().reverse().forEach(r => { (repliesByPost[r.post_id] = repliesByPost[r.post_id] || []).push(r); });
      const catName = id => (catById[id] && catById[id].name) || "";
      const catIcon = id => (catById[id] && catById[id].icon) || "";
      const items = [];
      // Post-Karten mit Inline-Antworten + Bumping (die jüngste Aktivität bestimmt die Reihenfolge)
      Object.values(postById).forEach(p => {
        const reps = repliesByPost[p.id] || [];
        const lastReply = reps.length ? reps[reps.length - 1].created_at : null;
        const sortWhen = lastReply && new Date(lastReply) > new Date(p.created_at) ? lastReply : p.created_at;
        items.push({ key: "p" + p.id, kind: "post", actor: p.display_name || "Mitglied", when: p.created_at, sortWhen, post: p, title: p.title, body: p.body, category: catName(p.category_id), categoryIcon: catIcon(p.category_id), isMatrix: !!p.matrix_data, replies: reps, lastReplyWhen: lastReply });
      });
      // System-Ereignisse (Status, Highscore, neues Mitglied) als eigene Karten
      arr(events).forEach(e => items.push({ key: "e" + e.id, eventId: e.id, userId: e.user_id, kind: e.kind, actor: e.display_name || "Mitglied", when: e.created_at, sortWhen: e.created_at, payload: e.payload || {} }));
      // Kommentare zu den Ereigniskarten frisch mitladen und die Karte anhand des
      // jüngsten Kommentars nach oben holen (Bumping wie bei Beiträgen).
      const eventIds = items.filter(i => i.eventId).map(i => i.eventId);
      let commentsByEvent = {};
      if (eventIds.length) {
        const cms = await q("activity_comments", `event_id=in.(${eventIds.join(",")})&order=created_at.asc`);
        arr(cms).forEach(c => { (commentsByEvent[c.event_id] = commentsByEvent[c.event_id] || []).push(c); });
      }
      setForumStreamComments(commentsByEvent);
      items.forEach(it => {
        if (it.eventId) {
          const cl = commentsByEvent[it.eventId];
          if (cl && cl.length) {
            const last = cl[cl.length - 1].created_at;
            if (new Date(last) > new Date(it.sortWhen)) it.sortWhen = last;
          }
        }
      });
      items.sort((a, b) => new Date(b.sortWhen) - new Date(a.sortWhen));
      setForumStream(items.slice(0, 30));
    } catch {}
    setForumStreamLoading(false);
  };

  // Kommentare zu den Stream-Ereignissen laden (in einem Rutsch) und nach event_id gruppieren.
  const loadStreamComments = async (eventIds) => {
    if (!eventIds || !eventIds.length) { setForumStreamComments({}); return; }
    try {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/activity_comments?event_id=in.(${eventIds.join(",")})&order=created_at.asc`, { headers: dbHeaders() });
      const data = await r.json();
      const map = {};
      (Array.isArray(data) ? data : []).forEach(c => { (map[c.event_id] = map[c.event_id] || []).push(c); });
      setForumStreamComments(map);
    } catch {}
  };

  // Inline-Antwort auf eine Post-Karte im Stream — hebt den Beitrag sofort nach oben (Bumping).
  const addStreamReply = async (postId) => {
    const uid = getUserId();
    if (!uid) { setView("forum-login-noetig"); return; }
    const text = (streamReplyDrafts[postId] || "").trim();
    if (!text) return;
    const target = streamReplyTo[postId] || null; // {id, name} oder null
    const replyToId = target ? target.id : null;
    setStreamReplyDrafts(prev => ({ ...prev, [postId]: "" }));
    setStreamReplyTo(prev => { const n = {...prev}; delete n[postId]; return n; });
    const optimistic = { id: "tmp-" + Date.now(), post_id: postId, user_id: uid, display_name: userDisplayName || "Mitglied", body: text, created_at: new Date().toISOString(), reply_to_id: replyToId };
    setForumStream(prev => {
      const list = prev.map(it => (it.kind === "post" && it.post && it.post.id === postId)
        ? { ...it, replies: [...(it.replies || []), optimistic], sortWhen: optimistic.created_at, lastReplyWhen: optimistic.created_at }
        : it);
      list.sort((a, b) => new Date(b.sortWhen) - new Date(a.sortWhen));
      return list;
    });
    setStreamRepliesExpanded(prev => ({ ...prev, [postId]: true }));
    try {
      await fetch(`${SUPABASE_URL}/rest/v1/forum_replies`, {
        method: "POST", headers: {...dbHeaders(), "Prefer": "return=minimal"},
        body: JSON.stringify({ post_id: postId, user_id: uid, display_name: userDisplayName || "Mitglied", body: text, reply_to_id: replyToId })
      });
    } catch {}
    // Autoritativ vom Server nachladen: sortiert den Beitrag anhand der jüngsten
    // Antwort verlässlich nach oben (Bumping), unabhängig vom optimistischen Sprung.
    loadForumStream();
    loadForumCategories();
  };

  // Bearbeiten/Löschen direkt im Stream — aktualisiert forumStream lokal, damit man
  // nicht ins Forum wechseln muss.
  const saveStreamPostEdit = async (id, title, body) => {
    if (!title.trim() || !body.trim()) return;
    try {
      await fetch(`${SUPABASE_URL}/rest/v1/forum_posts?id=eq.${id}`, {
        method: "PATCH", headers: dbHeaders(), body: JSON.stringify({ title: title.trim(), body: body.trim() })
      });
      setForumStream(prev => prev.map(it => (it.kind === "post" && it.post?.id === id)
        ? { ...it, title: title.trim(), body: body.trim(), post: { ...it.post, title: title.trim(), body: body.trim() } } : it));
      setForumEditingPostId(null);
    } catch {}
  };
  const deleteStreamPost = async (id) => {
    try {
      await fetch(`${SUPABASE_URL}/rest/v1/forum_posts?id=eq.${id}`, { method: "DELETE", headers: dbHeaders() });
      setForumStream(prev => prev.filter(it => !(it.kind === "post" && it.post?.id === id)));
    } catch {}
  };
  const saveStreamReplyEdit = async (id, body, postId) => {
    if (!body.trim()) return;
    try {
      await fetch(`${SUPABASE_URL}/rest/v1/forum_replies?id=eq.${id}`, {
        method: "PATCH", headers: dbHeaders(), body: JSON.stringify({ body: body.trim() })
      });
      setForumStream(prev => prev.map(it => (it.kind === "post" && it.post?.id === postId)
        ? { ...it, replies: (it.replies || []).map(r => r.id === id ? { ...r, body: body.trim() } : r) } : it));
      setForumEditingReplyId(null);
    } catch {}
  };
  const deleteStreamReply = async (id, postId) => {
    try {
      await fetch(`${SUPABASE_URL}/rest/v1/forum_replies?id=eq.${id}`, { method: "DELETE", headers: dbHeaders() });
      setForumStream(prev => prev.map(it => (it.kind === "post" && it.post?.id === postId)
        ? { ...it, replies: (it.replies || []).filter(r => r.id !== id) } : it));
    } catch {}
  };
  // Status-/Ereigniskarte (activity_events) löschen — eigene oder als Mod/Admin.
  const deleteStreamEvent = async (eventId) => {
    try {
      await fetch(`${SUPABASE_URL}/rest/v1/activity_events?id=eq.${eventId}`, { method: "DELETE", headers: dbHeaders() });
      setForumStream(prev => prev.filter(it => it.eventId !== eventId));
    } catch {}
  };
  // Kommentar unter einer Ereigniskarte (activity_comments) löschen.
  const deleteStreamComment = async (commentId, eventId) => {
    try {
      await fetch(`${SUPABASE_URL}/rest/v1/activity_comments?id=eq.${commentId}`, { method: "DELETE", headers: dbHeaders() });
      setForumStreamComments(prev => ({ ...prev, [eventId]: (prev[eventId] || []).filter(c => c.id !== commentId) }));
    } catch {}
  };

  // Rekursiv: eine Antwort samt ihrer Unter-Antworten (verschachtelt, eingerückt) rendern.
  const renderStreamReplyNode = (allReplies, postId, c, depth) => {
    const kids = allReplies.filter(r => r.reply_to_id === c.id).sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    const editing = forumEditingReplyId === c.id;
    return (
      <div key={c.id} style={{ marginLeft: depth > 0 ? 12 : 0, paddingLeft: depth > 0 ? 8 : 0, borderLeft: depth > 0 ? `2px solid ${lightMode?"rgba(200,168,224,0.4)":"rgba(200,169,110,0.2)"}` : "none", marginBottom:7 }}>
        {editing ? (
          <InlineEditBox lightMode={lightMode} initialValue={c.body}
            onSave={(v) => saveStreamReplyEdit(c.id, v, postId)}
            onCancel={() => setForumEditingReplyId(null)} />
        ) : (
          <div style={{ fontSize:12, lineHeight:1.5 }}>
            <span style={{ fontWeight:"bold", color:gold }}>{c.display_name} </span>
            <span style={{ color:lightMode?"#6a4a90":"#7a6040", fontSize:9 }}>{streamTimeAgo(c.created_at)}</span>
            <span style={{ marginLeft:6, whiteSpace:"nowrap" }}>
              {!isGuest && (
                <button onClick={() => setStreamReplyTo(prev => ({...prev, [postId]: {id: c.id, name: c.display_name}}))} title="Antworten" style={{ background:"transparent", border:"none", color:lightMode?"#6a4a90":"#9a8060", cursor:"pointer", fontSize:11, padding:0, marginRight:6 }}>↩</button>
              )}
              {forumCanEdit(c, c.user_id) && (
                <button onClick={() => setForumEditingReplyId(c.id)} title="Bearbeiten" style={{ background:"transparent", border:"none", color:lightMode?"#2a0850":"#9a8060", cursor:"pointer", fontSize:10, padding:0, marginRight:6 }}>✎</button>
              )}
              {(isMod || c.user_id === getUserId()) && (
                <button onClick={() => { if(window.confirm("Antwort löschen?")) deleteStreamReply(c.id, postId); }} title="Löschen" style={{ background:"transparent", border:"none", color:"#9a6050", cursor:"pointer", fontSize:10, padding:0 }}>✕</button>
              )}
            </span>
            <div style={{ color:lightMode?"#2a0850":"#c8b89a", marginTop:2 }}>{renderTextWithVideos(c.body || "")}</div>
          </div>
        )}
        {kids.map(k => renderStreamReplyNode(allReplies, postId, k, Math.min(depth + 1, 5)))}
      </div>
    );
  };

  // Statusbeitrag ("Was machst du gerade?") als activity_event in den Stream legen.
  const postStreamStatus = async () => {    const uid = getUserId();
    if (!uid) { setView("forum-login-noetig"); return; }
    const text = streamStatusText.trim();
    if (!text) return;
    setStreamStatusText("");
    try {
      await fetch(`${SUPABASE_URL}/rest/v1/activity_events`, {
        method: "POST", headers: {...dbHeaders(), "Prefer": "return=minimal"},
        body: JSON.stringify({ user_id: uid, display_name: userDisplayName || "Mitglied", kind: "status", payload: { text } })
      });
    } catch {}
    loadForumStream();
  };

  // Kommentar zu einem Stream-Ereignis abgeben (optimistisch).
  const addStreamComment = async (eventId) => {
    const uid = getUserId();
    if (!uid) { setView("forum-login-noetig"); return; }
    const text = (streamCommentDrafts[eventId] || "").trim();
    if (!text) return;
    const target = streamCommentReplyTo[eventId] || null;
    const parentId = target ? target.id : null;
    setStreamCommentDrafts(prev => ({ ...prev, [eventId]: "" }));
    setStreamCommentReplyTo(prev => { const n = {...prev}; delete n[eventId]; return n; });
    const now = new Date().toISOString();
    const optimistic = { id: "tmp-" + Date.now(), event_id: eventId, user_id: uid, display_name: userDisplayName || "Mitglied", body: text, created_at: now, parent_id: parentId };
    setForumStreamComments(prev => ({ ...prev, [eventId]: [...(prev[eventId] || []), optimistic] }));
    // Ereigniskarte sofort nach oben holen (Bumping)
    setForumStream(prev => {
      const list = prev.map(it => it.eventId === eventId ? { ...it, sortWhen: now } : it);
      list.sort((a, b) => new Date(b.sortWhen) - new Date(a.sortWhen));
      return list;
    });
    try {
      await fetch(`${SUPABASE_URL}/rest/v1/activity_comments`, {
        method: "POST", headers: {...dbHeaders(), "Prefer": "return=minimal"},
        body: JSON.stringify({ event_id: eventId, user_id: uid, display_name: userDisplayName || "Mitglied", body: text, ...(parentId ? { parent_id: parentId } : {}) })
      });
    } catch {}
    // Autoritativ nachladen: bestätigt Speicherung + Reihenfolge verlässlich.
    loadForumStream();
  };

  // Rekursiv: einen Kommentar samt seiner Unter-Kommentare (verschachtelt) rendern.
  const renderStreamCommentNode = (allComments, eventId, c, depth) => {
    const kids = allComments.filter(x => x.parent_id === c.id).sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    return (
      <div key={c.id} style={{ marginLeft: depth > 0 ? 12 : 0, paddingLeft: depth > 0 ? 8 : 0, borderLeft: depth > 0 ? `2px solid ${lightMode?"rgba(200,168,224,0.4)":"rgba(200,169,110,0.2)"}` : "none", marginBottom:6 }}>
        <div style={{ fontSize:12, lineHeight:1.5 }}>
          <span style={{ fontWeight:"bold", color:gold }}>{c.display_name} </span>
          <span style={{ color:lightMode?"#6a4a90":"#7a6040", fontSize:9 }}>{streamTimeAgo(c.created_at)}</span>
          <span style={{ marginLeft:6, whiteSpace:"nowrap" }}>
            {!isGuest && (
              <button onClick={() => { setStreamCommentsOpen(prev => ({...prev, [eventId]: true})); setStreamCommentReplyTo(prev => ({...prev, [eventId]: {id: c.id, name: c.display_name}})); }} title="Antworten" style={{ background:"transparent", border:"none", color:lightMode?"#6a4a90":"#9a8060", cursor:"pointer", fontSize:11, padding:0, marginRight:6 }}>↩</button>
            )}
            {(isMod || c.user_id === getUserId()) && (
              <button onClick={() => { if(window.confirm("Kommentar löschen?")) deleteStreamComment(c.id, eventId); }} title="Löschen" style={{ background:"transparent", border:"none", color:"#9a6050", cursor:"pointer", fontSize:10, padding:0 }}>✕</button>
            )}
          </span>
          <div style={{ color:lightMode?"#2a0850":"#c8b89a", marginTop:2 }}>{renderTextWithVideos(c.body || "")}</div>
        </div>
        {kids.map(k => renderStreamCommentNode(allComments, eventId, k, Math.min(depth + 1, 5)))}
      </div>
    );
  };

  // Wiederverwendbare Seitenleisten (auf allen Seiten gleich).
  const renderLeftRail = () => (
    isGuest ? (
      <div style={{ background:lightMode?"rgba(200,168,224,0.10)":"rgba(200,169,110,0.04)", border:`1px solid ${lightMode?"rgba(200,168,224,0.45)":"rgba(200,169,110,0.25)"}`, borderRadius:14, padding:"20px 16px", textAlign:"center" }}>
        <div style={{ fontSize:26, marginBottom:8 }}>🕯️</div>
        <div style={{ fontSize:12.5, color:lightMode?"#2a0850":"#d4c4a0", marginBottom:12, lineHeight:1.5 }}>Melde dich an, um mitzumachen.</div>
        <button onClick={() => setView("forum-login-noetig")} style={{ background:lightMode?"rgba(200,168,224,0.18)":"rgba(200,169,110,0.12)", border:`1px solid ${lightMode?"#c8a8e0":gold}`, color:gold, padding:"6px 14px", borderRadius:6, cursor:"pointer", fontSize:11, fontFamily:"Georgia,serif" }}>Anmelden</button>
      </div>
    ) : (
      <div onClick={() => { setView("forum"); setCommunityMode("profil"); }} style={{ background:lightMode?"rgba(200,168,224,0.10)":"rgba(200,169,110,0.04)", border:`1px solid ${lightMode?"rgba(200,168,224,0.45)":"rgba(200,169,110,0.25)"}`, borderRadius:14, padding:"18px 16px", textAlign:"center", cursor:"pointer" }}>
        <div style={{ width:56, height:56, borderRadius:"50%", background:"rgba(200,169,110,0.12)", border:`1px solid ${lightMode?"#c8a8e0":gold}`, display:"flex", alignItems:"center", justifyContent:"center", fontSize:24, color:gold, fontFamily:"Georgia,serif", margin:"0 auto 10px" }}>
          {(userDisplayName || "?").trim().charAt(0).toUpperCase() || "?"}
        </div>
        <div style={{ fontSize:14, color:gold, marginBottom:6, fontWeight:"bold" }}>{userDisplayName || "Willkommen"}</div>
        <div style={{ fontSize:10, color:lightMode?"#2a0850":"#7a6040", background:lightMode?"rgba(200,168,224,0.25)":"rgba(200,169,110,0.08)", display:"inline-block", padding:"3px 10px", borderRadius:10 }}>{forumRoleLabel(userRole)}</div>
        <div style={{ fontSize:10, color:lightMode?"#6a4a90":"#7a6040", marginTop:10 }}>Mein Profil →</div>
      </div>
    )
  );

  const renderRightRail = () => (<>
    <div style={{ background:lightMode?"rgba(200,168,224,0.08)":"rgba(200,169,110,0.03)", border:`1px solid ${lightMode?"rgba(200,168,224,0.35)":"rgba(200,169,110,0.18)"}`, borderRadius:14, padding:"24px 16px", textAlign:"center" }}>
      <div style={{ fontSize:30, marginBottom:12 }}>🕯️</div>
      <div style={{ fontSize:12, fontStyle:"italic", color:lightMode?"#5a3a6a":"#9a8060", lineHeight:1.7 }}>„Wahrheit fühlt sich an."</div>
      <div style={{ marginTop:18, fontSize:18, opacity:0.45 }}>🌙 ✦ 🐍</div>
    </div>
    {isAdmin && (
      <div style={{ background:lightMode?"rgba(200,168,224,0.06)":"rgba(200,169,110,0.02)", border:`1px solid ${lightMode?"rgba(200,168,224,0.30)":"rgba(200,169,110,0.15)"}`, borderRadius:14, padding:"16px 14px", marginTop:16 }}>
        <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:6 }}>
          <span style={{ fontSize:10, letterSpacing:2, color:lightMode?"#2a0850":"#7a6040", textTransform:"uppercase", fontFamily:"Georgia,serif" }}>📌 Heute</span>
          <span style={{ fontSize:9, color:lightMode?"#6a4a90":"#7a6040" }}>{manifestSaveStatus === "saving" ? "speichert…" : manifestSaveStatus === "saved" ? "✓" : manifestSaveStatus === "error" ? "⚠︎" : ""}</span>
        </div>
        <div style={{ fontSize:9, color:lightMode?"#6a4a90":"#7a6040", fontStyle:"italic", marginBottom:6 }}>Was ist jetzt dran? — eine Zeile pro Punkt</div>
        <textarea value={manifestData.heute} onChange={e => updateManifest("heute", e.target.value)}
          placeholder={"ausreichend schlafen\nmehr Wasser trinken\neinen Brief schreiben"}
          rows={4}
          style={{ width:"100%", padding:"8px 10px", background:"rgba(200,169,110,0.04)", border:`1px solid ${lightMode?"rgba(80,30,120,0.25)":"rgba(200,169,110,0.2)"}`, borderRadius:6, color:lightMode?"#2a0850":"#d4c4a0", fontFamily:"Georgia,serif", fontSize:12, outline:"none", boxSizing:"border-box", resize:"vertical", lineHeight:1.7 }} />
        {manifestData.heute && (
          <div style={{ marginTop:8, paddingTop:8, borderTop:`1px solid ${lightMode?"rgba(200,168,224,0.25)":"rgba(200,169,110,0.12)"}` }}>
            {manifestData.heute.split('\n').map(s => s.trim()).filter(Boolean).map((item, i, arr) => {
              const checked = (manifestData._checked_heute || []).includes(i);
              return (
                <div key={i} style={{ display:"flex", alignItems:"center", gap:6, marginBottom:4, padding:"3px 4px", borderRadius:4, background: checked?(lightMode?"rgba(200,168,224,0.18)":"rgba(90,154,90,0.10)"):"transparent" }}>
                  <button onClick={() => {
                    const current = manifestData._checked_heute || [];
                    const newChecked = checked ? current.filter(x => x !== i) : [...current, i];
                    updateManifest("_checked_heute", newChecked);
                  }} style={{ background:"none", border:"none", cursor:"pointer", fontSize:13, padding:0, color: checked?"#7a9a6a":(lightMode?"#7a5c90":"#9a8060") }}>{checked ? "☑️" : "☐"}</button>
                  <span style={{ flex:1, fontSize:11.5, color: checked?(lightMode?"#8a7aa0":"#8a9a7a"):(lightMode?"#2a0850":"#c8b89a"), textDecoration: checked?"line-through":"none", lineHeight:1.6 }}>{item}</span>
                  {i > 0 && (
                    <button onClick={() => {
                      const items = manifestData.heute.split('\n').map(s=>s.trim()).filter(Boolean);
                      const oldChecked = manifestData._checked_heute || [];
                      [items[i-1], items[i]] = [items[i], items[i-1]];
                      const newChecked = oldChecked.map(idx => idx===i ? i-1 : idx===i-1 ? i : idx);
                      const updated = {...manifestData, heute: items.join('\n'), _checked_heute: newChecked};
                      setManifestData(updated); saveManifest(updated);
                    }} style={{ background:"none", border:"none", cursor:"pointer", fontSize:10, color:lightMode?"#6a4a90":"#9a8060", padding:"0 2px" }} title="nach oben">⬆</button>
                  )}
                  {i < arr.length-1 && (
                    <button onClick={() => {
                      const items = manifestData.heute.split('\n').map(s=>s.trim()).filter(Boolean);
                      const oldChecked = manifestData._checked_heute || [];
                      [items[i], items[i+1]] = [items[i+1], items[i]];
                      const newChecked = oldChecked.map(idx => idx===i ? i+1 : idx===i+1 ? i : idx);
                      const updated = {...manifestData, heute: items.join('\n'), _checked_heute: newChecked};
                      setManifestData(updated); saveManifest(updated);
                    }} style={{ background:"none", border:"none", cursor:"pointer", fontSize:10, color:lightMode?"#6a4a90":"#9a8060", padding:"0 2px" }} title="nach unten">⬇</button>
                  )}
                  <button onClick={() => {
                    const { items, newChecked } = removeManifestItem(manifestData, "heute", i);
                    const updated = {...manifestData, heute: items.join('\n'), _checked_heute: newChecked};
                    setManifestData(updated); saveManifest(updated);
                  }} style={{ background:"none", border:"none", cursor:"pointer", fontSize:10, color:"#9a6050", padding:"0 2px" }}>✕</button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    )}
  </>);

  // Stream frisch laden, sobald man auf der Forum-Startseite im Stream-Tab landet.
  React.useEffect(() => {
    if (view === "forum" && forumView === "liste" && forumStartTab === "stream") loadForumStream();
  }, [view, forumView, forumStartTab, session]);

  // Alle Beitrags-IDs laden, die diese Person schon geöffnet hat — einmal beim Login/Start,
  // damit "ungelesen" in der ganzen Forum-Übersicht direkt korrekt angezeigt werden kann.
  const loadForumReadPosts = async () => {
    const uid = getUserId();
    if (!uid) { setForumReadPostIds(new Set()); return; }
    try {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/forum_post_reads?user_id=eq.${uid}&select=post_id`, {headers: dbHeaders()});
      const data = await r.json();
      if (Array.isArray(data)) setForumReadPostIds(new Set(data.map(d => d.post_id)));
    } catch {}
  };

  React.useEffect(() => {
    loadForumReadPosts();
  }, [session]);

  // Markiert einen Beitrag als von dieser Person gelesen — wird beim Öffnen aufgerufen.
  // Optimistisch sofort in der Oberfläche aktualisiert, damit es ohne Verzögerung wirkt.
  const markForumPostRead = async (postId) => {
    const uid = getUserId();
    if (!uid) return; // Gäste haben kein Gelesen-Tracking
    if (forumReadPostIds.has(postId)) return; // schon als gelesen markiert, nichts zu tun
    setForumReadPostIds(prev => new Set(prev).add(postId));
    try {
      await fetch(`${SUPABASE_URL}/rest/v1/forum_post_reads`, {
        method: "POST", headers: {...dbHeaders(), "Prefer": "resolution=merge-duplicates"},
        body: JSON.stringify({ user_id: uid, post_id: postId })
      });
    } catch {}
  };

  const loadForumReplies = async (postId) => {
    setForumRepliesVisibleCount(20); // bei jedem neuen Beitrag wieder von vorn beginnen
    try {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/forum_replies?post_id=eq.${postId}&order=created_at.asc`, {headers: dbHeaders()});
      const data = await r.json();
      if (Array.isArray(data)) {
        setForumReplies(data);
        const replyIds = data.map(rep => rep.id);
        if (replyIds.length > 0) {
          try {
            const lr = await fetch(`${SUPABASE_URL}/rest/v1/forum_reply_likes?reply_id=in.(${replyIds.join(",")})&select=reply_id,user_id`, {headers: dbHeaders()});
            const likesData = await lr.json();
            if (Array.isArray(likesData)) {
              const counts = {};
              const mine = {};
              const uid = getUserId();
              likesData.forEach(l => {
                counts[l.reply_id] = (counts[l.reply_id] || 0) + 1;
                if (uid && l.user_id === uid) mine[l.reply_id] = true;
              });
              setForumLikeCounts(counts);
              setForumMyLikes(mine);
            }
          } catch {}
        } else {
          setForumLikeCounts({});
          setForumMyLikes({});
        }
      }
    } catch {}
  };

  // Schaltet einen Like für eine Antwort um — optimistisches Update zuerst (fühlt sich
  // sofort an), dann der eigentliche Datenbank-Befehl im Hintergrund.
  const toggleForumReplyLike = async (replyId) => {
    const uid = getUserId();
    if (!uid) { setView("forum-login-noetig"); return; }
    const alreadyLiked = !!forumMyLikes[replyId];
    setForumMyLikes(prev => ({ ...prev, [replyId]: !alreadyLiked }));
    setForumLikeCounts(prev => ({ ...prev, [replyId]: (prev[replyId] || 0) + (alreadyLiked ? -1 : 1) }));
    try {
      if (alreadyLiked) {
        await fetch(`${SUPABASE_URL}/rest/v1/forum_reply_likes?reply_id=eq.${replyId}&user_id=eq.${uid}`, {method:"DELETE", headers: dbHeaders()});
      } else {
        await fetch(`${SUPABASE_URL}/rest/v1/forum_reply_likes`, {
          method: "POST", headers: {...dbHeaders(), "Prefer": "resolution=merge-duplicates"},
          body: JSON.stringify({ reply_id: replyId, user_id: uid })
        });
      }
    } catch {}
  };

  const openForumCategory = (cat) => {
    if (!forumCanEnterCategory(cat)) {
      // Gast (oder fehlende Pro-Berechtigung) klickt auf eine geschützte Kategorie:
      // als Appetit-Macher sieht man sie zwar in der Liste, zum Betreten braucht's aber Login/Pro.
      setForumActiveCategory(cat); // merken, damit man nach dem Login direkt dort landet
      setView("forum-login-noetig");
      return;
    }
    setForumActiveCategory(cat);
    setForumView("kategorie");
    loadForumPosts(cat.id);
  };

  const openForumPost = (post) => {
    setForumActivePost(post);
    setForumView("post");
    loadForumReplies(post.id);
    loadForumPostLikes(post.id);
    markForumPostRead(post.id);
  };

  // Lädt die Likes für EINEN Beitrag — eigene Funktion statt Teil von loadForumReplies,
  // damit sie auch beim direkten Öffnen per Permalink unabhängig aufrufbar ist.
  const loadForumPostLikes = async (postId) => {
    try {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/forum_post_likes?post_id=eq.${postId}&select=user_id`, {headers: dbHeaders()});
      const data = await r.json();
      if (Array.isArray(data)) {
        const uid = getUserId();
        setForumPostLikeCount(data.length);
        setForumMyPostLike(uid ? data.some(l => l.user_id === uid) : false);
      }
    } catch {}
  };

  // Gleiches Prinzip wie toggleForumReplyLike — optimistisches Update zuerst.
  const toggleForumPostLike = async (postId) => {
    const uid = getUserId();
    if (!uid) { setView("forum-login-noetig"); return; }
    const alreadyLiked = forumMyPostLike;
    setForumMyPostLike(!alreadyLiked);
    setForumPostLikeCount(prev => prev + (alreadyLiked ? -1 : 1));
    try {
      if (alreadyLiked) {
        await fetch(`${SUPABASE_URL}/rest/v1/forum_post_likes?post_id=eq.${postId}&user_id=eq.${uid}`, {method:"DELETE", headers: dbHeaders()});
      } else {
        await fetch(`${SUPABASE_URL}/rest/v1/forum_post_likes`, {
          method: "POST", headers: {...dbHeaders(), "Prefer": "resolution=merge-duplicates"},
          body: JSON.stringify({ post_id: postId, user_id: uid })
        });
      }
    } catch {}
  };

  // Lädt einen Beitrag direkt anhand seiner ID und öffnet ihn — für Permalinks
  // (z.B. #post-xyz aus einem geteilten Link), unabhängig davon ob die Kategorie
  // schon geladen wurde. Falls der Beitrag nicht (mehr) existiert oder nicht
  // zugänglich ist, landet man einfach in der normalen Forum-Übersicht.
  const loadAndOpenPostById = async (postId) => {
    try {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/forum_posts?id=eq.${postId}`, {headers: dbHeaders()});
      const data = await r.json();
      const post = data && data[0];
      if (!post) { setView("forum"); setForumView("liste"); return; }
      const cat = forumCategories.find(c => c.id === post.category_id);
      setView("forum");
      setForumActiveCategory(cat || {id: post.category_id});
      openForumPost(post);
    } catch {
      setView("forum"); setForumView("liste");
    }
  };

  // Teilt die aktuell angezeigte Tageskarte als Beitrag in der "Tageskarten"-Kategorie.
  // Sucht die Kategorie anhand des Namens — falls sie fehlt (SQL noch nicht ausgeführt),
  // gibt es eine klare Fehlermeldung statt eines stillen Fehlschlags.
  const shareTageskarteToForum = async (includeNotes) => {
    const uid = getUserId();
    if (!uid) { setView("forum-login-noetig"); return; }
    setShareTageskarteStatus("sharing");
    try {
      let cat = forumCategories.find(c => c.name === "Tageskarten");
      if (!cat) {
        // Kategorie evtl. noch nicht im lokalen State (z.B. gerade erst angelegt) — frisch nachladen
        const r = await fetch(`${SUPABASE_URL}/rest/v1/forum_categories?name=eq.Tageskarten&section=eq.forum`, {headers: dbHeaders()});
        const data = await r.json();
        cat = data && data[0];
      }
      if (!cat) { setShareTageskarteStatus("error"); return; }

      const cardNames = `${CARDS[selectedCard.c1].name} & ${CARDS[selectedCard.c2].name}`;
      const title = `${SYMBOLS[selectedCard.c1]}${SYMBOLS[selectedCard.c2]} ${cardNames} — ${formatDate(selectedDateKey)}`;
      let body = `Meine Tageskombination am ${formatDate(selectedDateKey)}: ${cardNames}.`;
      if (includeNotes) {
        const parts = [];
        if (selectedEntry.gedanken.trim()) parts.push(`💭 Gedanken: ${selectedEntry.gedanken.trim()}`);
        if (selectedEntry.reflexionen.trim()) parts.push(`🌙 Reflexionen: ${selectedEntry.reflexionen.trim()}`);
        if (selectedEntry.resumee.trim()) parts.push(`📝 Resümee: ${selectedEntry.resumee.trim()}`);
        if (parts.length) body += `\n\n${parts.join("\n\n")}`;
      }

      const r = await fetch(`${SUPABASE_URL}/rest/v1/forum_posts`, {
        method: "POST", headers: {...dbHeaders(), "Prefer": "return=representation"},
        body: JSON.stringify({ category_id: cat.id, user_id: uid, display_name: userDisplayName || "Mitglied", title, body })
      });
      const data = await r.json();
      if (data && data[0]) {
        setShareTageskarteStatus("done");
        loadForumCategories();
        setTimeout(() => { setShareTageskarteOpen(false); setShareTageskarteStatus(""); }, 1500);
      } else {
        setShareTageskarteStatus("error");
      }
    } catch { setShareTageskarteStatus("error"); }
  };

  // Teilt die aktuell angezeigte Frage-Deutung (Situations- oder Personen-Matrix) als
  // Beitrag in der "Fragen & Deutungen"-Kategorie — fasst alle 9 Felder mit Text
  // zusammen, genau wie es die Druckfunktion daneben auch tut.
  const shareFrageToForum = async () => {
    const uid = getUserId();
    if (!uid) { setView("forum-login-noetig"); return; }
    if (!signifikator) return;
    setShareFrageStatus("sharing");
    try {
      let cat = forumCategories.find(c => c.name === "Fragen & Deutungen");
      if (!cat) {
        const r = await fetch(`${SUPABASE_URL}/rest/v1/forum_categories?name=eq.Fragen%20%26%20Deutungen&section=eq.forum`, {headers: dbHeaders()});
        const data = await r.json();
        cat = data && data[0];
      }
      if (!cat) { setShareFrageStatus("error"); return; }

      const sig = signifikator;
      const cardName = CARDS[sig].name;
      const sigSymbol = SYMBOLS[sig];
      const isPersonen = mode === "personen";
      const posLabels = isPersonen
        ? ["Sternzeichen","Haarfarbe","Charakter","Figur","Signifikator","Beruf/Berufung","Größe","Alter","Woher"]
        : ["Gedanken","Ist-Situation","Rat der Engel","Warnung","Signifikator","Nahe Zukunft","Wo es herkommt","Unbewusste Zukunft","Ergebnis und wann"];
      const sitKeys = ["gendanken",null,"rat_der_engel","warnung",null,null,"wo_es_herkommt",null,"ergebnis_und_wann"];
      const perKeys = ["sternzeichen","haarfarbe","charakter","figur",null,"beruf","groesse","alter","woher"];
      const activeKeys = isPersonen ? perKeys : sitKeys;
      const kombiPos = isPersonen ? [] : [1,5,7];

      const lines = [];
      const cells = []; // strukturiert für das visuelle Raster im Forum (matrix_data)
      for (let pos = 0; pos < 9; pos++) {
        const card = matrixCards[pos];
        const isSig = pos === 4;
        const isKombi = kombiPos.includes(pos);
        let text = "";
        if (isSig) {
          text = isPersonen ? (PERSON_MATRIX[String(sig)]?.signifikator || CARDS[sig].kw) : CARDS[sig].kw;
        } else if (isKombi && card) {
          const lo = Math.min(sig, card), hi = Math.max(sig, card);
          text = COMBOS[lo+"-"+hi] || "";
        } else if (activeKeys[pos] && card) {
          const src = isPersonen ? PERSON_MATRIX[String(card)] : MATRIX[String(card)];
          text = src ? src[activeKeys[pos]] : "";
        }
        cells.push({
          label: posLabels[pos], isSig, isKombi, text: text || "",
          card: !!card, cardSymbol: card ? SYMBOLS[card] : "", cardName: card ? CARDS[card].name : ""
        });
        if (!text) continue;
        const cardDisplay = card ? `${SYMBOLS[card]} ${CARDS[card].name}` : "";
        lines.push(`**${posLabels[pos]}**${cardDisplay ? ` (${cardDisplay})` : ""}: ${text}`);
      }

      const title = `${sigSymbol} ${cardName} · ${isPersonen ? "Personen-Matrix" : "Situations-Matrix"}${question ? ` — ${question}` : ""}`;
      // body bleibt als reiner Text-Fallback erhalten (z.B. für Benachrichtigungen,
      // Suche, oder falls matrix_data aus irgendeinem Grund fehlt) — die eigentliche
      // Anzeige im Forum nutzt aber bevorzugt das visuelle Raster aus matrix_data.
      let body = question ? `✦ ${question}\n\n` : "";
      body += lines.join("\n\n");
      const matrixData = { mode, question, sigSymbol, sigName: cardName, cells };

      const r = await fetch(`${SUPABASE_URL}/rest/v1/forum_posts`, {
        method: "POST", headers: {...dbHeaders(), "Prefer": "return=representation"},
        body: JSON.stringify({ category_id: cat.id, user_id: uid, display_name: userDisplayName || "Mitglied", title, body, matrix_data: matrixData })
      });
      const data = await r.json();
      if (data && data[0]) {
        setShareFrageStatus("done");
        loadForumCategories();
        setTimeout(() => setShareFrageStatus(""), 1500);
      } else {
        setShareFrageStatus("error");
      }
    } catch { setShareFrageStatus("error"); }
  };

  const createForumPost = async () => {
    setForumError("");
    if (!forumNewTitle.trim() || !forumNewBody.trim()) { setForumError("Bitte Titel und Text ausfüllen."); return; }
    if (isGuest && !forumNewName.trim()) { setForumError("Bitte gib einen Namen an, unter dem deine Frage erscheinen soll."); return; }
    const uid = getUserId();
    try {
      const payload = {
        category_id: forumActiveCategory.id,
        user_id: uid || null,
        display_name: uid ? (userDisplayName || "Mitglied") : forumNewName.trim(),
        title: forumNewTitle.trim(),
        body: forumNewBody.trim()
      };
      const r = await fetch(`${SUPABASE_URL}/rest/v1/forum_posts`, {
        method: "POST", headers: {...dbHeaders(), "Prefer": "return=representation"},
        body: JSON.stringify(payload)
      });
      const data = await r.json();
      if (data && data[0]) {
        setForumNewTitle(""); setForumNewBody(""); setForumNewName("");
        loadForumPosts(forumActiveCategory.id);
        loadForumCategories(); // Zähler + Sortierung nach Aktivität aktualisieren
        setForumView("kategorie");
      } else {
        setForumError("Konnte nicht gespeichert werden. Versuch's gleich noch mal.");
      }
    } catch { setForumError("Konnte nicht gespeichert werden. Versuch's gleich noch mal."); }
  };

  const createForumReply = async (postIdArg) => {
    if (!forumReplyText.trim()) return;
    const uid = getUserId();
    const postId = postIdArg || forumActivePost?.id;
    if (!postId) return;
    try {
      const payload = {
        post_id: postId,
        user_id: uid || null,
        display_name: uid ? (userDisplayName || "Mitglied") : (forumNewName.trim() || "Anonym"),
        body: forumReplyText.trim(),
        reply_to_id: forumReplyToId || null
      };
      const r = await fetch(`${SUPABASE_URL}/rest/v1/forum_replies`, {
        method: "POST", headers: {...dbHeaders(), "Prefer": "return=representation"},
        body: JSON.stringify(payload)
      });
      const data = await r.json();
      if (data && data[0]) {
        setForumReplyText("");
        setForumReplyToId(null);
        setForumReplyToName("");
        loadForumReplies(postId);
      }
    } catch {}
  };

  const deleteForumPost = async (id) => {
    try {
      await fetch(`${SUPABASE_URL}/rest/v1/forum_posts?id=eq.${id}`, {method:"DELETE", headers: dbHeaders()});
      setForumPosts(prev => prev.filter(p => p.id !== id));
      if (forumActivePost?.id === id) { setForumActivePost(null); setForumView("kategorie"); }
    } catch {}
  };

  const deleteForumReply = async (id) => {
    try {
      await fetch(`${SUPABASE_URL}/rest/v1/forum_replies?id=eq.${id}`, {method:"DELETE", headers: dbHeaders()});
      setForumReplies(prev => prev.filter(r => r.id !== id));
    } catch {}
  };

  // Eigene Beiträge/Antworten dürfen nur innerhalb von 24 Stunden nach dem Erstellen
  // bearbeitet werden — danach bleibt der Text fest, damit alte Diskussionen nicht
  // nachträglich beliebig verändert werden können. Mods/Admins dürfen ohnehin löschen,
  // aber auch für sie gilt dieses Zeitfenster fürs Bearbeiten (nur Inhalt, nicht Löschen).
  const forumCanEdit = (item, authorId) => {
    if (isMod) return true; // Mods und Admins dürfen immer, egal wann und von wem
    if (authorId !== getUserId()) return false;
    const ageMs = Date.now() - new Date(item.created_at).getTime();
    return ageMs < 24 * 60 * 60 * 1000;
  };

  const startEditForumPost = (post) => {
    setForumEditingPostId(post.id);
  };

  const saveEditForumPost = async (id, newTitle, newBody) => {
    if (!newTitle.trim() || !newBody.trim()) return;
    try {
      await fetch(`${SUPABASE_URL}/rest/v1/forum_posts?id=eq.${id}`, {
        method: "PATCH", headers: dbHeaders(),
        body: JSON.stringify({ title: newTitle.trim(), body: newBody.trim() })
      });
      setForumPosts(prev => prev.map(p => p.id === id ? {...p, title: newTitle.trim(), body: newBody.trim()} : p));
      if (forumActivePost?.id === id) setForumActivePost(prev => ({...prev, title: newTitle.trim(), body: newBody.trim()}));
      setForumEditingPostId(null);
    } catch {}
  };

  const startEditForumReply = (reply) => {
    setForumEditingReplyId(reply.id);
  };

  const saveEditForumReply = async (id, newBody) => {
    if (!newBody.trim()) return;
    try {
      await fetch(`${SUPABASE_URL}/rest/v1/forum_replies?id=eq.${id}`, {
        method: "PATCH", headers: dbHeaders(), body: JSON.stringify({ body: newBody.trim() })
      });
      setForumReplies(prev => prev.map(r => r.id === id ? {...r, body: newBody.trim()} : r));
      setForumEditingReplyId(null);
    } catch {}
  };

  const createForumCategory = async (section = "forum", directFields = null) => {
    const name = directFields ? directFields.name : forumNewCatName;
    const description = directFields ? directFields.description : forumNewCatDescription;
    const icon = directFields ? directFields.icon : forumNewCatIcon;
    const visibility = directFields ? directFields.visibility : forumNewCatVisibility;
    const guestPost = directFields ? directFields.guestPost : forumNewCatGuestPost;
    if (!name.trim()) return;
    try {
      const payload = {
        name: name.trim(),
        description: description.trim(),
        icon: (icon || "💬").trim().slice(0, 4),
        visibility,
        guest_can_post: guestPost,
        sort_order: section === "kurse" ? kurseCategories.length : forumCategories.length
      };
      // section nur mitschicken wenn die Spalte existiert (SQL-Migration ausgeführt).
      // Supabase ignoriert unbekannte Felder nicht immer — daher defensiv prüfen.
      try { payload.section = section; } catch {}

      const r = await fetch(`${SUPABASE_URL}/rest/v1/forum_categories`, {
        method: "POST", headers: {...dbHeaders(), "Prefer": "return=representation"},
        body: JSON.stringify(payload)
      });
      const text = await r.text();
      let data;
      try { data = JSON.parse(text); } catch { data = null; }

      // Supabase gibt manchmal ein Error-Objekt statt Array zurück
      if (!Array.isArray(data) || !data[0]) {
        console.error("createForumCategory Fehler:", text);
        // Trotzdem neu laden, falls die Kategorie doch angelegt wurde
        if (section === "kurse") loadKurseCategories();
        else loadForumCategories();
        setForumShowNewCat(false);
        setKurseShowNewCat(false);
        return;
      }

      if (section === "kurse") setKurseCategories(prev => [...prev, data[0]]);
      else setForumCategories(prev => [...prev, data[0]]);
      setForumNewCatName(""); setForumNewCatDescription(""); setForumNewCatIcon("💬"); setForumNewCatVisibility("member"); setForumNewCatGuestPost(false);
      setForumShowNewCat(false);
      setKurseShowNewCat(false);
    } catch(e) {
      console.error("createForumCategory exception:", e);
    }
  };

  const deleteForumCategory = async (id) => {
    try {
      await fetch(`${SUPABASE_URL}/rest/v1/forum_categories?id=eq.${id}`, {method:"DELETE", headers: dbHeaders()});
      setForumCategories(prev => prev.filter(c => c.id !== id));
    } catch {}
  };

  // Bestehende Kategorie bearbeiten (Name, Beschreibung, Icon, Sichtbarkeit, Gäste-Schreibrecht).
  // sort_order bleibt hier unangetastet — Umsortieren ist ein eigenes Feature für später.
  const saveEditForumCategory = async (id, fields) => {
    if (!fields.name.trim()) return;
    const payload = {
      name: fields.name.trim(),
      description: fields.description.trim(),
      icon: (fields.icon || "💬").trim().slice(0, 4),
      visibility: fields.visibility,
      guest_can_post: fields.guestPost,
    };
    try {
      await fetch(`${SUPABASE_URL}/rest/v1/forum_categories?id=eq.${id}`, {
        method: "PATCH", headers: dbHeaders(), body: JSON.stringify(payload)
      });
      setForumCategories(prev => prev.map(c => c.id === id ? {...c, ...payload} : c));
      setForumEditingCategoryId(null);
    } catch {}
  };

  const toggleForumCategoryPin = async (cat) => {
    const newPinned = !cat.pinned;
    // Optimistisch sofort in der Oberfläche aktualisieren, dann erst speichern
    setForumCategories(prev => {
      const updated = prev.map(c => c.id === cat.id ? {...c, pinned: newPinned} : c);
      updated.sort((a, b) => {
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
        if (a.pinned && b.pinned) return a.sort_order - b.sort_order;
        if (!a.lastActivity && !b.lastActivity) return a.sort_order - b.sort_order;
        if (!a.lastActivity) return 1;
        if (!b.lastActivity) return -1;
        return b.lastActivity.localeCompare(a.lastActivity);
      });
      return updated;
    });
    try {
      await fetch(`${SUPABASE_URL}/rest/v1/forum_categories?id=eq.${cat.id}`, {
        method: "PATCH", headers: dbHeaders(), body: JSON.stringify({pinned: newPinned})
      });
    } catch {}
  };

  // Beitrag innerhalb einer Kategorie anpinnen/lösen — gleiches Prinzip wie bei Kategorien
  const toggleForumPostPin = async (post) => {
    const newPinned = !post.pinned;
    setForumPosts(prev => {
      const updated = prev.map(p => p.id === post.id ? {...p, pinned: newPinned} : p);
      updated.sort((a, b) => {
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
        return b.created_at.localeCompare(a.created_at);
      });
      return updated;
    });
    try {
      await fetch(`${SUPABASE_URL}/rest/v1/forum_posts?id=eq.${post.id}`, {
        method: "PATCH", headers: dbHeaders(), body: JSON.stringify({pinned: newPinned})
      });
    } catch {}
  };

  // Speichert Name + Bio im eigenen Profil
  const saveProfile = async (fields) => {
    const uid = getUserId();
    if (!uid) return;
    setProfileSaveStatus("saving");
    try {
      await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${uid}`, {
        method: "PATCH", headers: dbHeaders(),
        body: JSON.stringify({
          display_name: fields.name.trim(), bio: fields.bio.trim(), signature: fields.signature.trim(),
          birthdate: fields.birthdate || null, gender: fields.gender || null
        })
      });
      setUserDisplayName(fields.name.trim());
      setUserBio(fields.bio.trim());
      setUserSignature(fields.signature.trim());
      setUserBirthdate(fields.birthdate || "");
      setUserGender(fields.gender || "");
      setProfileEditing(false);
      setProfileSaveStatus("saved");
      setTimeout(() => setProfileSaveStatus(""), 2000);
    } catch {
      setProfileSaveStatus("error");
    }
  };

  const createFolder = async () => {
    if (!newFolderName.trim()) return;
    const uid = getUserId();
    if (!uid) return;
    try {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/writing_project_folders`, {
        method:"POST", headers: {...dbHeaders(), "Prefer":"return=representation"},
        body: JSON.stringify({user_id: uid, name: newFolderName.trim()})
      });
      const data = await r.json();
      if (data && data[0]) {
        setFolders(prev => [...prev, data[0]]);
        setSelectedFolder(data[0].id);
      }
      setNewFolderName(""); setShowNewFolder(false);
    } catch {}
  };

  const deleteFolder = async (id) => {
    const uid = getUserId();
    if (!uid) return;
    try {
      await fetch(`${SUPABASE_URL}/rest/v1/writing_project_folders?id=eq.${id}`, {method:"DELETE", headers: dbHeaders()});
      setFolders(prev => prev.filter(f => f.id !== id));
      if (selectedFolder === id) setSelectedFolder(null);
    } catch {}
  };

  const [templateSaveError, setTemplateSaveError] = React.useState("");
  const saveTemplate = async () => {
    if (!newTemplateName.trim()) return;
    const uid = getUserId();
    if (!uid) return;
    setTemplateSaveError("");
    try {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/writing_text_templates`, {
        method:"POST", headers: {...dbHeaders(), "Prefer":"return=representation"},
        body: JSON.stringify({
          user_id: uid,
          name: newTemplateName.trim(),
          notes: writingNotes
        })
      });
      if (!r.ok) {
        const errText = await r.text();
        setTemplateSaveError(errText.slice(0, 200));
        return;
      }
      const data = await r.json();
      if (data && data[0]) {
        // Liste komplett frisch aus der Datenbank holen, statt nur lokal zu ergänzen —
        // verhindert, dass ein veralteter lokaler Stand später zu Verwechslungen führt.
        const freshList = await loadAllWritingData();
        const fresh = freshList?.find(t => t.id === data[0].id) || data[0];
        setSelectedTemplate(fresh);
        setNewTemplateName(""); setShowSaveTemplate(false);
      } else {
        setTemplateSaveError("Unbekannte Antwort von der Datenbank.");
      }
    } catch (e) {
      setTemplateSaveError(String(e?.message || e).slice(0, 200));
    }
  };

  // Aktualisiert eine bereits bestehende Vorlage mit dem kompletten aktuellen Notizen-Stand
  const updateTemplate = async (tpl) => {
    const uid = getUserId();
    if (!uid) return;
    setTemplateSaveError("");
    try {
      const updatedFields = { notes: writingNotes };
      const r = await fetch(`${SUPABASE_URL}/rest/v1/writing_text_templates?id=eq.${tpl.id}`, {
        method:"PATCH", headers: {...dbHeaders(), "Prefer":"return=representation"},
        body: JSON.stringify(updatedFields)
      });
      if (!r.ok) {
        const errText = await r.text();
        setTemplateSaveError(errText.slice(0, 200));
        return;
      }
      const data = await r.json();
      if (data && data[0]) {
        const freshList = await loadAllWritingData();
        const fresh = freshList?.find(t => t.id === tpl.id) || data[0];
        setSelectedTemplate(fresh);
        setShowSaveTemplate(false);
      } else {
        setTemplateSaveError("Aktualisierung kam ohne Bestätigung zurück — bitte erneut versuchen.");
      }
    } catch (e) {
      setTemplateSaveError(String(e?.message || e).slice(0, 200));
    }
  };

  // Vorlage umbenennen
  const renameTemplate = async (tpl, newName) => {
    if (!newName.trim()) return;
    const uid = getUserId();
    if (!uid) return;
    try {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/writing_text_templates?id=eq.${tpl.id}`, {
        method:"PATCH", headers: {...dbHeaders(), "Prefer":"return=representation"},
        body: JSON.stringify({ name: newName.trim() })
      });
      const data = await r.json();
      const updated = (data && data[0]) ? data[0] : {...tpl, name: newName.trim()};
      setTextTemplates(prev => prev.map(t => t.id === tpl.id ? updated : t));
      if (selectedTemplate?.id === tpl.id) setSelectedTemplate(updated);
    } catch {}
  };

  const applyTemplate = (tpl) => {
    // Komplettes Notizen-Objekt der Vorlage übernehmen (alle Felder: Intro, Teaser,
    // alle Kartenpositionen, Subplot, Teaser-Auflösung, Outro), nicht nur Intro/Outro.
    const n = {...(tpl.notes || {})};
    setWritingNotes(n);
    setSelectedTemplate(tpl);
    saveWritingSession(n, writingProjekt, writingBemerkung);
    setShowLoadTemplate(false);
  };

  const deleteTemplate = async (id) => {
    const uid = getUserId();
    if (!uid) return;
    try {
      await fetch(`${SUPABASE_URL}/rest/v1/writing_text_templates?id=eq.${id}`, {method:"DELETE", headers: dbHeaders()});
      setTextTemplates(prev => prev.filter(t => t.id !== id));
    } catch {}
  };

  const printFolder = (folderId) => {
    const folderName = folders.find(f => f.id === folderId)?.name || "Projekt";
    const sessions = savedProjects.filter(p => p.folder_id === folderId);
    const posLabels = ["Gedanken","IST-Situation","Rat der Engel","Warnung","Signifikator","Nahe Zukunft","Ursache","Unbewusste Zukunft","Ergebnis"];
    const html = "<html><head><title>" + folderName + "</title><style>"
      + "body{font-family:Georgia,serif;max-width:700px;margin:40px auto;color:#2a1a0a;line-height:1.7}"
      + "h1{color:#8a6020;border-bottom:2px solid #c8a96e;padding-bottom:8px}"
      + "h2{color:#8a6020;margin-top:40px;border-bottom:1px solid #c8a96e;padding-bottom:4px}"
      + ".meta{font-size:11px;color:#9a8060;margin-bottom:16px}"
      + ".block{margin-bottom:16px;border-left:3px solid #c8a96e;padding-left:12px}"
      + ".lbl{font-size:10px;color:#9a8060;letter-spacing:2px;text-transform:uppercase;margin-bottom:3px}"
      + ".txt{font-size:12px;color:#3a2a0a;white-space:pre-wrap}"
      + "</style></head><body>"
      + "<h1>✍️ " + folderName + "</h1>"
      + sessions.map(s => {
          const notes = s.notes || {};
          const cards = s.matrix_cards || [];
          return "<h2>" + s.name + "</h2>"
            + "<div class='meta'>" + new Date(s.updated_at).toLocaleDateString('de-DE') + (s.bemerkung ? " · " + s.bemerkung : "") + (s.hook ? " · 🎯 " + s.hook : "") + "</div>"
            + (notes["intro"] ? "<div class='block'><div class='lbl'>🎬 Intro</div><div class='txt'>" + notes["intro"] + "</div></div>" : "")
            + (notes["nachIntro"] ? "<div class='block'><div class='lbl'>💥 Teaser</div><div class='txt'>" + notes["nachIntro"] + "</div></div>" : "")
            + [4,0,1,2].map(pos => {
                const t = notes[String(pos)] || "";
                if (!t) return "";
                const cn = cards[pos];
                return "<div class='block'><div class='lbl'>" + posLabels[pos] + (cn ? " · " + CARDS[cn]?.name : "") + "</div><div class='txt'>" + t + "</div></div>";
              }).join("")
            + [5].map(pos => {
                const t = notes[String(pos)] || "";
                if (!t) return "";
                const cn = cards[pos];
                return "<div class='block'><div class='lbl'>" + posLabels[pos] + (cn ? " · " + CARDS[cn]?.name : "") + "</div><div class='txt'>" + t + "</div></div>";
              }).join("")
            + (notes["nachRatDerEngel"] ? "<div class='block'><div class='lbl'>💕 Subplot</div><div class='txt'>" + notes["nachRatDerEngel"] + "</div></div>" : "")
            + [6,7,3,8].map(pos => {
                const t = notes[String(pos)] || "";
                if (!t) return "";
                const cn = cards[pos];
                return "<div class='block'><div class='lbl'>" + posLabels[pos] + (cn ? " · " + CARDS[cn]?.name : "") + "</div><div class='txt'>" + t + "</div></div>";
              }).join("")
            + (notes["vorOutro"] ? "<div class='block'><div class='lbl'>💥 Teaser-Auflösung</div><div class='txt'>" + notes["vorOutro"] + "</div></div>" : "")
            + (notes["outro"] ? "<div class='block'><div class='lbl'>🎬 Outro</div><div class='txt'>" + notes["outro"] + "</div></div>" : "");
        }).join("<hr style='margin:32px 0;border-color:#c8a96e'>")
      + "</body></html>";
    const w = window.open("","_blank");
    w.document.write(html);
    w.document.close();
    w.print();
  };

  const saveProject = async () => {
    const uid = getUserId();
    if (!uid) return;
    // Immer den allerneuesten Stand aus den Refs lesen, nicht aus dem Closure dieser Funktion —
    // sonst könnte ein verzögerter Timer-Aufruf einen veralteten (z.B. noch leeren) Stand sehen.
    const curNotes = writingNotesRef.current;
    const curProjekt = writingProjektRef.current;
    const curHook = writingHookRef.current;
    const curBemerkung = writingBemerkungRef.current;
    // Nichts speichern, wenn die Session komplett leer ist (nur gewürfelt/Karten gewählt, aber
    // noch nirgends Text eingegeben) — das hat sonst bei jedem Tab-Wechsel direkt nach dem Würfeln
    // ein neues, leeres "Unbenannt"-Projekt angelegt.
    const hasAnyContent = Boolean(
      (curProjekt && curProjekt.trim()) ||
      (curHook && curHook.trim()) ||
      (curBemerkung && curBemerkung.trim()) ||
      Object.values(curNotes || {}).some(v => v && String(v).trim())
    );
    if (!hasAnyContent && !writingProjectId) {
      return;
    }
    // Lock: läuft schon ein Speichervorgang, merken wir uns, dass danach nochmal gespeichert werden muss,
    // statt einen zweiten parallelen Request zu starten (das hat zu doppelten/vielfachen Projekten geführt).
    if (writingIsSaving.current) {
      writingPendingResave.current = true;
      return;
    }
    writingIsSaving.current = true;
    // Auch ohne Namen speichern, damit nichts verloren geht — Fallback-Name verwenden
    const nameToSave = curProjekt || ("Unbenannt · " + new Date().toLocaleDateString('de-DE') + " " + new Date().toLocaleTimeString('de-DE', {hour:'2-digit', minute:'2-digit'}));
    setWritingSaveStatus("saving");
    setWritingSaveError("");
    try {
      const payload = {
        user_id: uid,
        name: nameToSave,
        bemerkung: curBemerkung,
        hook: curHook,
        notes: curNotes,
        matrix_cards: matrixCards,
        signifikator: signifikator,
        intro_card: introCard,
        outro_card: outroCard,
        folder_id: selectedFolder || null,
        template_id: selectedTemplate?.id || null,
        writing_mode: writingMode,
        matrix_free_text: matrixFreeText,
        updated_at: new Date().toISOString()
      };
      let ok = true, errText = "";
      if (writingProjectId) {
        const res = await fetch(`${SUPABASE_URL}/rest/v1/writing_projects?id=eq.${writingProjectId}`, {
          method:"PATCH", headers: dbHeaders(), body: JSON.stringify(payload)
        });
        ok = res.ok;
        if (!ok) errText = await res.text();
      } else {
        const r = await fetch(`${SUPABASE_URL}/rest/v1/writing_projects`, {
          method:"POST", headers: {...dbHeaders(), "Prefer":"return=representation"},
          body: JSON.stringify(payload)
        });
        ok = r.ok;
        if (!ok) {
          errText = await r.text();
        } else {
          const data = await r.json();
          if (data && data[0]) setWritingProjectId(data[0].id);
        }
      }
      // Refresh list
      const r2 = await fetch(`${SUPABASE_URL}/rest/v1/writing_projects?user_id=eq.${uid}&order=updated_at.desc`, {headers: dbHeaders()});
      const list = await r2.json();
      if (Array.isArray(list)) setSavedProjects(list);
      setWritingSaveStatus(ok ? "saved" : "error");
      if (!ok) setWritingSaveError(errText.slice(0, 200));
    } catch (e) {
      setWritingSaveStatus("error");
      setWritingSaveError(String(e?.message || e).slice(0, 200));
    } finally {
      writingIsSaving.current = false;
      // Während des Speicherns kam eine weitere Änderung dazu -> einmal nachspeichern
      if (writingPendingResave.current) {
        writingPendingResave.current = false;
        saveProject();
      }
    }
  };

  const loadProject = (proj) => {
    setWritingProjekt(proj.name);
    setWritingBemerkung(proj.bemerkung||"");
    setWritingHook(proj.hook||"");
    setWritingNotes(proj.notes||{});
    setWritingProjectId(proj.id);
    setSelectedFolder(proj.folder_id || null);
    if (proj.matrix_cards) setMatrixCards(proj.matrix_cards);
    if (proj.signifikator) setSignifikator(proj.signifikator);
    // Immer explizit setzen (auch auf null) — sonst bliebe beim Laden eines älteren Projekts
    // ohne Intro-/Outro-Karte die Karte einer zuvor geöffneten Session fälschlich stehen.
    setIntroCard(proj.intro_card || null);
    setOutroCard(proj.outro_card || null);
    setWritingMode(proj.writing_mode || "situation");
    setMatrixFreeText(proj.matrix_free_text || {});
    // Falls die Session ursprünglich mit einer Vorlage erstellt wurde, diese wieder als "ausgewählt" markieren,
    // damit "Speichern unter" → "Vorlage aktualisieren" korrekt die richtige Vorlage anbietet
    if (proj.template_id) {
      const tpl = textTemplates.find(t => t.id === proj.template_id);
      setSelectedTemplate(tpl || null);
    } else {
      setSelectedTemplate(null);
    }
    setShowProjects(false);
    setWritingView("writing");
  };

  const deleteProject = async (id) => {
    const uid = getUserId();
    if (!uid) return;
    try {
      await fetch(`${SUPABASE_URL}/rest/v1/writing_projects?id=eq.${id}`, {method:"DELETE", headers: dbHeaders()});
      setSavedProjects(prev => prev.filter(p => p.id !== id));
      if (writingProjectId === id) { setWritingProjectId(null); }
    } catch {}
  };

  // Findet Sessions, die nirgends Inhalt haben (nur durch Würfeln/Tab-Wechsel entstanden, nie beschrieben)
  const isEmptyProject = (p) => {
    const nameIsAuto = !p.name || p.name.startsWith("Unbenannt");
    const hasNotes = p.notes && Object.values(p.notes).some(v => v && String(v).trim());
    return nameIsAuto && !p.bemerkung?.trim() && !p.hook?.trim() && !hasNotes;
  };
  const emptyProjectsCount = savedProjects.filter(isEmptyProject).length;
  const cleanupEmptyProjects = async () => {
    const uid = getUserId();
    if (!uid) return;
    const toDelete = savedProjects.filter(isEmptyProject);
    if (toDelete.length === 0) return;
    try {
      await Promise.all(toDelete.map(p =>
        fetch(`${SUPABASE_URL}/rest/v1/writing_projects?id=eq.${p.id}`, {method:"DELETE", headers: dbHeaders()})
      ));
      const deletedIds = new Set(toDelete.map(p => p.id));
      setSavedProjects(prev => prev.filter(p => !deletedIds.has(p.id)));
      if (deletedIds.has(writingProjectId)) setWritingProjectId(null);
    } catch {}
  };

  const saveWritingSession = (notes, projekt, bemerkung) => {
    // Refs sofort synchron aktualisieren (zusätzlich zum useEffect), damit der Timer-Callback
    // garantiert den aktuellsten Stand sieht, auch wenn er sehr knapp nach einer Änderung feuert.
    writingNotesRef.current = notes;
    writingProjektRef.current = projekt;
    writingBemerkungRef.current = bemerkung;
    if (writingTimer.current) clearTimeout(writingTimer.current);
    setWritingSaveStatus("saving");
    writingTimer.current = setTimeout(() => saveProject(), 1500);
  };

  const getUserId = () => {
    try {
      const s = JSON.parse(localStorage.getItem("sb_session")||"null");
      if (!s) return null;
      const payload = JSON.parse(atob(s.access_token.split('.')[1]));
      return payload.sub;
    } catch { return null; }
  };

  // Liest die E-Mail-Adresse aus dem Login-Token aus — nur zur Anzeige im Profil,
  // eine Änderung der E-Mail-Adresse selbst ist (noch) nicht möglich.
  const getUserEmail = () => {
    try {
      const s = JSON.parse(localStorage.getItem("sb_session")||"null");
      if (!s) return "";
      const payload = JSON.parse(atob(s.access_token.split('.')[1]));
      return payload.email || "";
    } catch { return ""; }
  };

  // Praktische Helfer, um im Code lesbar zu prüfen, was jemand darf
  const isGuest = !session || !getUserId();
  const isAdmin = userRole === "admin";
  const isMod = userRole === "mod" || isAdmin;
  // Nur echte Käufer — Test-PRO ("pro" via 14-Tage-Trial) kommt hier nicht rein.
  // Du vergibst pro_full manuell im Supabase-Dashboard bei jedem echten Kauf.
  const isProFull = userRole === "pro_full" || isMod;
  // Pro-Zugang hat JEDER ab Pro aufwärts: Test-Pro, Voll-Pro, Mod, Admin.
  // (pro_full MUSS hier mit rein, sonst wird ein Vollmitglied fälschlich
  //  aus den Pro-Bereichen ausgesperrt — "Zutritt nur für Pro-Mitglieder".)
  const isPro = userRole === "pro" || isProFull;

  // Im eigentlichen Schreib-Bereich (3x3-Matrix + Textboxen) sollen die Seitenleisten weg,
  // damit maximaler Platz zum Arbeiten bleibt. Die Projektauswahl behält den Rahmen.
  const writingFullWidth = view === "tagebuch" && dailyMode === "writing" && (writingView === "picking" || writingView === "writing");

  // Kann diese Kategorie überhaupt gesehen werden, je nach Sichtbarkeits-Stufe + eigener Rolle?
  // Alle Kategorien werden in der Übersicht angezeigt (auch für Gäste, als Appetit-Macher) —
  // forumCanEnterCategory entscheidet, ob man tatsächlich hineinklicken kann, oder ob
  // stattdessen der Login-Bildschirm kommt.
  const forumCanEnterCategory = (cat) => {
    if (cat.visibility === "guest") return true;
    if (cat.visibility === "pro") return isPro;
    return !isGuest; // "member"-Sichtbarkeit: alles außer Gast
  };
  // Beibehalten für eventuelle spätere Stellen, die nur die echten Lese-Rechte brauchen
  const forumCanSeeCategory = forumCanEnterCategory;

  const getAccessToken = () => {
    try { return JSON.parse(localStorage.getItem("sb_session")||"null")?.access_token || null; }
    catch { return null; }
  };

  const dbHeaders = () => {
    const s = JSON.parse(localStorage.getItem("sb_session")||"null");
    return {
      "apikey": SUPABASE_KEY,
      "Authorization": `Bearer ${s?.access_token || SUPABASE_KEY}`,
      "Content-Type": "application/json",
      "Prefer": "return=minimal"
    };
  };

  // Zauberzettel
  const emptyManifest = {heute:"", wochen:"", monate:"", jahre:"", irgendwann:"", traum:""};
  const [manifestData, setManifestData] = React.useState(emptyManifest);
  const [manifestSaveStatus, setManifestSaveStatus] = React.useState("idle"); // idle | saving | saved | error

  React.useEffect(() => {
    const loadManifest = async () => {
      const uid = getUserId();
      if (!uid) return;
      try {
        const r = await fetch(`${SUPABASE_URL}/rest/v1/zauberzettel?user_id=eq.${uid}&limit=1`, {headers: dbHeaders()});
        const data = await r.json();
        if (data && data[0]) {
          const {heute,wochen,monate,jahre,irgendwann,traum,checked_items} = data[0];
          setManifestData({
            heute:heute||"", wochen:wochen||"", monate:monate||"", jahre:jahre||"",
            irgendwann:irgendwann||"", traum:traum||"",
            ...(checked_items || {})
          });
        }
      } catch {}
    };
    loadManifest();
  }, [session]);

  const saveManifestTimer = React.useRef(null);
  const [manifestSaveError, setManifestSaveError] = React.useState("");
  const saveManifestNow = async (data) => {
    const uid = getUserId();
    if (!uid) return;
    setManifestSaveStatus("saving");
    setManifestSaveError("");
    try {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/zauberzettel?user_id=eq.${uid}&limit=1`, {headers: dbHeaders()});
      const existing = await r.json();
      let ok, errText = "";
      // Nur die echten Tabellenspalten senden, nicht die UI-internen _checked_* Felder
      const {heute, wochen, monate, jahre, irgendwann, traum} = data;
      const checkedItems = Object.fromEntries(
        Object.entries(data).filter(([k]) => k.startsWith("_checked_"))
      );
      const payload = {heute, wochen, monate, jahre, irgendwann, traum, checked_items: checkedItems};
      if (existing && existing[0]) {
        const res = await fetch(`${SUPABASE_URL}/rest/v1/zauberzettel?user_id=eq.${uid}`, {
          method:"PATCH", headers: dbHeaders(),
          body: JSON.stringify({...payload, updated_at: new Date().toISOString()})
        });
        ok = res.ok;
        if (!ok) errText = await res.text();
      } else {
        const res = await fetch(`${SUPABASE_URL}/rest/v1/zauberzettel`, {
          method:"POST", headers: dbHeaders(),
          body: JSON.stringify({user_id: uid, ...payload})
        });
        ok = res.ok;
        if (!ok) errText = await res.text();
      }
      setManifestSaveStatus(ok ? "saved" : "error");
      if (!ok) setManifestSaveError(errText.slice(0, 200));
    } catch (e) {
      setManifestSaveStatus("error");
      setManifestSaveError(String(e?.message || e).slice(0, 200));
    }
  };
  const saveManifest = (data) => {
    if (saveManifestTimer.current) clearTimeout(saveManifestTimer.current);
    setManifestSaveStatus("saving");
    saveManifestTimer.current = setTimeout(() => saveManifestNow(data), 400); // debounce 0.4 Sekunden
  };

  // Beim Verlassen der Seite / Tab-Wechsel sofort speichern, statt auf den Debounce-Timer zu warten
  React.useEffect(() => {
    const flush = () => {
      if (saveManifestTimer.current) {
        clearTimeout(saveManifestTimer.current);
        saveManifestNow(manifestData);
      }
    };
    window.addEventListener("beforeunload", flush);
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flush(); });
    return () => {
      window.removeEventListener("beforeunload", flush);
    };
  }, [manifestData]);

  const updateManifest = (field, value) => {
    const updated = {...manifestData, [field]: value};
    setManifestData(updated);
    saveManifest(updated);
  };

  // Entfernt Item an Index `i` aus der Liste `key` und gibt { newText, newChecked, removedWasChecked } zurück.
  // Sorgt dafür, dass die Checked-Markierungen (die über Indizes laufen) beim Entfernen korrekt mitwandern,
  // statt am alten Index "kleben" zu bleiben.
  const removeManifestItem = (data, key, i) => {
    const items = data[key].split('\n').map(s => s.trim()).filter(Boolean);
    const removed = items.splice(i, 1)[0];
    const checkedKey = `_checked_${key}`;
    const oldChecked = data[checkedKey] || [];
    const wasChecked = oldChecked.includes(i);
    // Indizes nach dem entfernten Element um 1 nach unten verschieben, i selbst raus
    const newChecked = oldChecked
      .filter(idx => idx !== i)
      .map(idx => idx > i ? idx - 1 : idx);
    return { items, removed, wasChecked, newChecked };
  };
  // Fügt Item in die Liste `key` ein (an Position `pos`, default Ende) und passt Checked-Indizes an.
  const insertManifestItem = (data, key, item, wasChecked, pos = null) => {
    const items = data[key] ? data[key].split('\n').map(s => s.trim()).filter(Boolean) : [];
    const insertAt = pos === null ? items.length : pos;
    const checkedKey = `_checked_${key}`;
    const oldChecked = data[checkedKey] || [];
    // Indizes ab der Einfügeposition um 1 nach oben verschieben
    const shiftedChecked = oldChecked.map(idx => idx >= insertAt ? idx + 1 : idx);
    items.splice(insertAt, 0, item);
    const newChecked = wasChecked ? [...shiftedChecked, insertAt] : shiftedChecked;
    return { text: items.join('\n'), checked: newChecked };
  };

  // ─────────────────────────────────────────────────────────────
  // Zauberzettel "Brief verbrennen" — Checklisten-Notiz + 3-Wochen-Archiv
  // Schreibe Wünsche (Enter = neue Checkbox), verbrenne sie, und nach
  // 3 Wochen öffnet sich das Siegel und du siehst, was sich erfüllt hat.
  // ─────────────────────────────────────────────────────────────
  const ZETTEL_LOCK_DAYS = 21; // 3 Wochen (Standard-Rückfall)
  // Drei wählbare Versiegelungs-Zeiten (3-3-3, aus der Spirit-Szene). Monate/Jahre
  // kalendergenau gerechnet, nicht in groben Tagen.
  const ZETTEL_DURATIONS = [
    { key:"3w", label:"3 Wochen", add:(d)=>{ const x=new Date(d); x.setDate(x.getDate()+21); return x; } },
    { key:"3m", label:"3 Monate", add:(d)=>{ const x=new Date(d); x.setMonth(x.getMonth()+3); return x; } },
    { key:"3y", label:"3 Jahre",  add:(d)=>{ const x=new Date(d); x.setFullYear(x.getFullYear()+3); return x; } },
  ];
  const [zettelDuration, setZettelDuration] = React.useState("3w");
  const zettelDurAdd = (key, base) => (ZETTEL_DURATIONS.find(d=>d.key===key) || ZETTEL_DURATIONS[0]).add(base);
  // Label aus der Spanne burned→unlock ableiten (kein neues DB-Feld nötig)
  const zettelLockLabel = (burned, unlock) => {
    const days = (new Date(unlock) - new Date(burned)) / 86400000;
    if (days < 40) return "3 Wochen";
    if (days < 200) return "3 Monate";
    return "3 Jahre";
  };
  const [zettelItems, setZettelItems] = React.useState([{ text:"", done:false }]);
  const [zettelArchiv, setZettelArchiv] = React.useState([]);
  const [zettelBurning, setZettelBurning] = React.useState(false);
  const [zettelBurnSnapshot, setZettelBurnSnapshot] = React.useState([]);
  const ZETTEL_SHOW_WISHES = true; // Wünsche aufs brennende Papier? (false = nur stilvoller Zettel)
  // Vorschau: auf true setzen, um ALLE Archiv-Einträge sofort zu entsiegeln
  // (zum Anschauen/Testen). Auf false lassen für den echten 3-Wochen-Zauber.
  const ZETTEL_UNLOCK_ALL = false;
  const [zettelFocus, setZettelFocus] = React.useState(null);
  const zettelInputRefs = React.useRef({});
  // Optik: gealtertes Notizpapier (in beiden Modi cremefarben — Papier ist Papier)
  const zettelPaperBg = "linear-gradient(135deg,#f6ecd4 0%,#efe1c2 48%,#e4d2aa 100%)";
  const zettelGrain = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='pg'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.8' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23pg)'/%3E%3C/svg%3E")`;

  // Archiv laden
  const loadZettelArchiv = async () => {
    const uid = getUserId();
    if (!uid) return;
    try {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/zauberzettel_archiv?user_id=eq.${uid}&order=burned_at.desc`, {headers: dbHeaders()});
      const data = await r.json();
      if (Array.isArray(data)) setZettelArchiv(data);
    } catch {}
  };
  React.useEffect(() => { loadZettelArchiv(); }, [session]);

  // Caveat-Handschrift für den Zauberzettel laden
  React.useEffect(() => {
    if (document.getElementById("caveat-font")) return;
    const l = document.createElement("link");
    l.id = "caveat-font"; l.rel = "stylesheet";
    l.href = "https://fonts.googleapis.com/css2?family=Caveat:wght@400;500;600;700&display=swap";
    document.head.appendChild(l);
  }, []);

  // Fokus auf neu erzeugte Checkbox-Zeile setzen
  React.useEffect(() => {
    if (zettelFocus != null && zettelInputRefs.current[zettelFocus]) {
      zettelInputRefs.current[zettelFocus].focus();
      setZettelFocus(null);
    }
  }, [zettelFocus, zettelItems]);

  const setZettelText = (i, val) => setZettelItems(prev => prev.map((it, idx) => idx === i ? {...it, text: val} : it));
  const toggleZettelDone = (i) => setZettelItems(prev => prev.map((it, idx) => idx === i ? {...it, done: !it.done} : it));
  const removeZettelItem = (i) => setZettelItems(prev => prev.length > 1 ? prev.filter((_, idx) => idx !== i) : prev);
  const zettelKeyDown = (e, i) => {
    if (e.key === "Enter") {
      e.preventDefault();
      setZettelItems(prev => { const next = [...prev]; next.splice(i+1, 0, {text:"", done:false}); return next; });
      setZettelFocus(i+1);
    } else if (e.key === "Backspace" && zettelItems[i].text === "" && zettelItems.length > 1) {
      e.preventDefault();
      setZettelItems(prev => prev.filter((_, idx) => idx !== i));
      setZettelFocus(Math.max(0, i-1));
    }
  };

  // Verbrennen: sofort versiegelt speichern, dann spielt die Flammen-Animation
  const verbrenneZettel = async () => {
    const items = zettelItems.map(it => ({ text:(it.text||"").trim(), done: !!it.done })).filter(it => it.text);
    if (items.length === 0 || zettelBurning) return;
    setZettelBurnSnapshot(items);
    setZettelBurning(true);
    const uid = getUserId();
    const burnedAt = new Date();
    const unlockAt = zettelDurAdd(zettelDuration, burnedAt);
    const entry = { user_id: uid, items, burned_at: burnedAt.toISOString(), unlock_at: unlockAt.toISOString() };
    if (uid) {
      try {
        await fetch(`${SUPABASE_URL}/rest/v1/zauberzettel_archiv`, {
          method:"POST", headers: dbHeaders(), body: JSON.stringify(entry)
        });
      } catch {}
    } else {
      setZettelArchiv(prev => [{...entry, id:"local_"+burnedAt.getTime()}, ...prev]);
    }
  };

  // Wird aufgerufen, wenn die Flammen-Animation durch ist
  const handleBurnDone = async () => {
    setZettelItems([{ text:"", done:false }]);
    setZettelBurnSnapshot([]);
    setZettelBurning(false);
    await loadZettelArchiv();
  };

  // Im entsiegelten Archiv einen Wunsch als "erfüllt" markieren
  const toggleArchivItem = async (entryIdx, itemIdx) => {
    const entry = zettelArchiv[entryIdx];
    if (!entry) return;
    const newItems = entry.items.map((it, i) => i === itemIdx ? {...it, done: !it.done} : it);
    setZettelArchiv(prev => prev.map((e, i) => i === entryIdx ? {...e, items: newItems} : e));
    if (entry.id && !String(entry.id).startsWith("local_")) {
      try {
        await fetch(`${SUPABASE_URL}/rest/v1/zauberzettel_archiv?id=eq.${entry.id}`, {
          method:"PATCH", headers: dbHeaders(), body: JSON.stringify({ items: newItems })
        });
      } catch {}
    }
  };

  // Einen erfüllten (oder beliebigen) Wunsch aus einem entsiegelten Eintrag löschen.
  // War es der letzte Wunsch, verschwindet der ganze Eintrag.
  const deleteArchivItem = async (entryIdx, itemIdx) => {
    const entry = zettelArchiv[entryIdx];
    if (!entry) return;
    const newItems = (entry.items||[]).filter((_, i) => i !== itemIdx);
    if (newItems.length === 0) { await deleteArchivEntry(entryIdx); return; }
    setZettelArchiv(prev => prev.map((e, i) => i === entryIdx ? {...e, items: newItems} : e));
    if (entry.id && !String(entry.id).startsWith("local_")) {
      try {
        await fetch(`${SUPABASE_URL}/rest/v1/zauberzettel_archiv?id=eq.${entry.id}`, {
          method:"PATCH", headers: dbHeaders(), body: JSON.stringify({ items: newItems })
        });
      } catch {}
    }
  };

  // Einen ganzen Archiv-Eintrag löschen
  const deleteArchivEntry = async (entryIdx) => {
    const entry = zettelArchiv[entryIdx];
    if (!entry) return;
    setZettelArchiv(prev => prev.filter((_, i) => i !== entryIdx));
    if (entry.id && !String(entry.id).startsWith("local_")) {
      try {
        await fetch(`${SUPABASE_URL}/rest/v1/zauberzettel_archiv?id=eq.${entry.id}`, {
          method:"DELETE", headers: dbHeaders()
        });
      } catch {}
    }
  };

  // Offene (noch nicht erfüllte) Wünsche eines entsiegelten Eintrags frisch versiegeln:
  // sie wandern in einen NEUEN Eintrag mit neuer, gewählter Laufzeit; im alten bleiben
  // nur die bereits erfüllten (ist keiner erfüllt, verschwindet der alte Eintrag).
  const reSealEntry = async (entryIdx, durationKey) => {
    const entry = zettelArchiv[entryIdx];
    if (!entry) return;
    const offen = (entry.items||[]).filter(it => !it.done).map(it => ({ text: it.text, done: false }));
    if (offen.length === 0) return;
    const erfuellt = (entry.items||[]).filter(it => it.done);
    const uid = getUserId();
    const burnedAt = new Date();
    const unlockAt = zettelDurAdd(durationKey, burnedAt);
    const neu = { user_id: uid, items: offen, burned_at: burnedAt.toISOString(), unlock_at: unlockAt.toISOString() };
    if (uid) {
      try {
        await fetch(`${SUPABASE_URL}/rest/v1/zauberzettel_archiv`, { method:"POST", headers: dbHeaders(), body: JSON.stringify(neu) });
        if (entry.id && !String(entry.id).startsWith("local_")) {
          if (erfuellt.length === 0) {
            await fetch(`${SUPABASE_URL}/rest/v1/zauberzettel_archiv?id=eq.${entry.id}`, { method:"DELETE", headers: dbHeaders() });
          } else {
            await fetch(`${SUPABASE_URL}/rest/v1/zauberzettel_archiv?id=eq.${entry.id}`, { method:"PATCH", headers: dbHeaders(), body: JSON.stringify({ items: erfuellt }) });
          }
        }
      } catch {}
      await loadZettelArchiv();
    } else {
      setZettelArchiv(prev => {
        const rest = prev.map((e,i) => i===entryIdx ? {...e, items: erfuellt} : e).filter(e => (e.items||[]).length>0);
        return [{...neu, id:"local_"+burnedAt.getTime()}, ...rest];
      });
    }
  };

  const druckeManifest = () => {
    const heute = new Date();
    const datumStr = heute.toLocaleDateString('de-DE', {day:'2-digit', month:'2-digit', year:'numeric'});
    const wochen = new Date(heute); wochen.setDate(heute.getDate()+21);
    const monate = new Date(heute); monate.setMonth(heute.getMonth()+3);
    const jahre = new Date(heute); jahre.setFullYear(heute.getFullYear()+3);
    const toList = (text) => text.split('\n').map(s => s.trim()).filter(Boolean)
      .map(s => "<div class='item'>☐ " + s + "</div>").join("");
    const html = "<html><head><title>Zauberzettel</title><style>"
      + "body{font-family:Georgia,serif;max-width:800px;margin:40px auto;color:#2a1a0a;line-height:1.7}"
      + "h1{color:#8a6020;border-bottom:2px solid #c8a96e;padding-bottom:8px;margin-bottom:4px}"
      + ".datum{font-size:11px;color:#9a8060;margin-bottom:24px;letter-spacing:1px}"
      + ".grid{display:grid;grid-template-columns:1fr 1fr;gap:24px;margin-top:16px}"
      + ".block{border:1px solid #c8a96e;border-radius:8px;padding:16px}"
      + ".label{font-size:10px;color:#9a8060;letter-spacing:3px;text-transform:uppercase;margin-bottom:4px}"
      + ".date{font-size:11px;color:#8a6020;margin-bottom:10px;font-style:italic}"
      + ".item{font-size:13px;color:#2a1a0a;margin-bottom:8px;padding-left:4px}"
      + "</style></head><body>"
      + "<h1>✨ Zauberzettel</h1>"
      + "<div class='datum'>" + datumStr + "</div>"
      + "<div class='grid'>"
      + "<div class='block'><div class='label'>📅 Heute</div><div class='date'>" + datumStr + "</div>" + toList(manifestData.heute) + "</div>"
      + "<div class='block'><div class='label'>⏱️ 3 Wochen</div><div class='date'>bis " + wochen.toLocaleDateString('de-DE') + "</div>" + toList(manifestData.wochen) + "</div>"
      + "<div class='block'><div class='label'>🌙 3 Monate</div><div class='date'>bis " + monate.toLocaleDateString('de-DE') + "</div>" + toList(manifestData.monate) + "</div>"
      + "<div class='block'><div class='label'>🌟 3 Jahre</div><div class='date'>bis " + jahre.toLocaleDateString('de-DE') + "</div>" + toList(manifestData.jahre) + "</div>"
      + (manifestData.irgendwann ? "<div class='block'><div class='label'>🌙 Irgendwann</div>" + toList(manifestData.irgendwann) + "</div>" : "")
      + (manifestData.traum ? "<div class='block'><div class='label'>💫 Beweise finden für:</div>" + toList(manifestData.traum) + "</div>" : "")
      + "</div></body></html>";
    const w = window.open("","_blank");
    w.document.write(html);
    w.document.close();
    w.print();
  }; // tagebuch | doku
  const [klientName, setKlientName] = React.useState("");
  const [klientGeburt, setKlientGeburt] = React.useState("");
  const getKlientSeed = () => {
    if (!klientGeburt) return undefined;
    const nums = klientGeburt.replace(/\D/g,"");
    return nums.split("").reduce((a,b) => a + parseInt(b), 0) * 137;
  };

  // Wird beim Login asynchron aus Supabase geladen (siehe loadRole-Effekt oben) — start
  // mit leerem Objekt, kein synchrones localStorage-Lesen mehr nötig.
  const [tagebuchData, setTagebuchData] = React.useState({});
  const [tagebuchSaveStatus, setTagebuchSaveStatus] = React.useState(""); // "" | "saving" | "saved"
  const [tippVisible, setTippVisible] = React.useState(false);
  // Teilen-Dialog: zeigt eine kleine Auswahl (Notizen mitschicken ja/nein) bevor
  // die Tageskarte als Beitrag im Forum landet.
  const [shareTageskarteOpen, setShareTageskarteOpen] = React.useState(false);
  const [shareTageskarteIncludeNotes, setShareTageskarteIncludeNotes] = React.useState(false);
  const [shareTageskarteStatus, setShareTageskarteStatus] = React.useState(""); // "" | "sharing" | "done" | "error"
  // Teilen der Frage-Deutung (Situations-/Personen-Matrix) im Forum — kein extra Dialog
  // nötig, da hier (anders als bei Tageskarten) keine separaten Notizfelder existieren,
  // die man optional ein-/ausschließen könnte.
  const [shareFrageStatus, setShareFrageStatus] = React.useState(""); // "" | "sharing" | "done" | "error"
  const todayKey = getTodayKey();
  // Navigation: welcher Tag wird gerade angezeigt? Standard: heute.
  const [selectedDateKey, setSelectedDateKey] = React.useState(todayKey);
  const selectedCard = getDailyCard(getKlientSeed() ?? userSeed, selectedDateKey);
  const selectedEntry = tagebuchData[selectedDateKey] || {gedanken:"", reflexionen:"", resumee:""};
  const isToday = selectedDateKey === todayKey;

  const navigateDay = (direction) => {
    const d = new Date(selectedDateKey + "T12:00:00");
    d.setDate(d.getDate() + direction);
    const newKey = d.toISOString().slice(0, 10);
    // Nicht in die Zukunft navigieren
    if (newKey > todayKey) return;
    setSelectedDateKey(newKey);
    setTippVisible(false);
  };

  const updateTagebuch = (field, value) => {
    const uid = getUserId();
    if (!uid) { setView("forum-login-noetig"); return; } // Login nötig zum Speichern
    const updated = {...tagebuchData, [selectedDateKey]: {...selectedEntry, [field]: value}};
    setTagebuchData(updated);
    setTagebuchSaveStatus("saving");
    if (tagebuchTimer.current) clearTimeout(tagebuchTimer.current);
    tagebuchTimer.current = setTimeout(async () => {
      await saveTagebuchEntry(uid, selectedDateKey, updated[selectedDateKey]);
      setTagebuchSaveStatus("saved");
      setTimeout(() => setTagebuchSaveStatus(""), 1500);
    }, 1500);
  };

  const druckeTagebuch = () => {
    const entries = Object.entries(tagebuchData).sort().reverse();
    const html = `<html><head><title>Lenormand Tageskarten</title><style>
      body{font-family:Georgia,serif;max-width:700px;margin:40px auto;color:#2a1a0a;line-height:1.7}
      h1{color:#8a6020;border-bottom:2px solid #c8a96e;padding-bottom:8px}
      .entry{margin-bottom:32px;border-left:3px solid #c8a96e;padding-left:16px}
      .date{font-size:11px;color:#9a8060;letter-spacing:2px;text-transform:uppercase;margin-bottom:4px}
      .karte{font-size:18px;color:#8a6020;margin-bottom:8px}
      .label{font-size:10px;color:#9a8060;letter-spacing:1px;text-transform:uppercase;margin-top:10px}
      .text{font-size:14px;color:#3a2a0a;margin-top:2px;white-space:pre-wrap}
    </style></head><body>
    <h1>📓 Lenormand Tageskarten · Anna Benoir</h1>
    ${entries.map(([key, entry]) => {
      const cardNum = (() => {
        const d = new Date(key);
        const seed = d.getFullYear()*10000 + (d.getMonth()+1)*100 + d.getDate();
        const keys2 = Object.keys(CARDS);
        const c1 = parseInt(keys2[seed % keys2.length]);
        const c2raw = parseInt(keys2[(seed * 7 + 13) % keys2.length]);
        const c2 = c2raw === c1 ? parseInt(keys2[(seed * 7 + 14) % keys2.length]) : c2raw;
        const lo = Math.min(c1,c2), hi = Math.max(c1,c2);
        return {c1, c2, comboKey:`${lo}-${hi}`};
      })();
      const card1 = CARDS[cardNum.c1];
      const card2 = CARDS[cardNum.c2];
      const gedankenHtml = entry.gedanken ? "<div class=\"label\">💭 Gedanken</div><div class=\"text\">" + entry.gedanken + "</div>" : "";
      const reflexionenHtml = entry.reflexionen ? "<div class=\"label\">🌙 Reflexionen</div><div class=\"text\">" + entry.reflexionen + "</div>" : "";
      const resumeeHtml = entry.resumee ? "<div class=\"label\">📝 Resümee</div><div class=\"text\">" + entry.resumee + "</div>" : "";
      const tippText = COMBOS[cardNum.comboKey] || "Vertraue deiner Intuition.";
      const tippHtml = "<div class=\"label\">✨ Tipp vom Universum</div><div class=\"text\">" + tippText + "</div>";
      return "<div class=\"entry\">" +
        "<div class=\"date\">" + key.split("-").reverse().join(".") + "</div>" +
        "<div class=\"karte\">" + SYMBOLS[cardNum.c1] + " " + cardNum.c1 + ". " + card1.name + " + " + SYMBOLS[cardNum.c2] + " " + cardNum.c2 + ". " + card2.name + "</div>" +
        gedankenHtml + reflexionenHtml + resumeeHtml + tippHtml +
        "</div>";
    }).join("")}
    </body></html>`;
    const w = window.open("","_blank");
    w.document.write(html);
    w.document.close();
    w.print();
  };
  const [mode, setMode] = useState("situation");
  // Picker mode
  const [selected, setSelected] = useState([]);
  const [search, setSearch] = useState("");
  const [cardDetail, setCardDetail] = useState(null);
  const [openSection, setOpenSection] = useState("2er");
  // Matrix mode
  const SPLASH_IMAGES = [
    "https://static.wixstatic.com/media/3da789_ed30c846006844ddb59845376bdc4bac~mv2.png",
    "https://static.wixstatic.com/media/3da789_0534370da2934f57bdca738855342004~mv2.png",
    "https://static.wixstatic.com/media/3da789_7ffdd0a734b8429f824597f8054f8c80~mv2.png",
    "https://static.wixstatic.com/media/3da789_0bd58126fe0a453f81d29caa8e79b4fb~mv2.png",
    "https://static.wixstatic.com/media/3da789_eea0bfe4991e4bbf98efe8a7031edd96~mv2.png",
    "https://static.wixstatic.com/media/3da789_e64fab6f653e47ff88bee696b39e4ef9~mv2.png",
    "https://static.wixstatic.com/media/3da789_fc8df5cd6f1c4deb8bbc5765858a39cf~mv2.png",
    "https://static.wixstatic.com/media/3da789_3789ae741704469084063e65452271e4~mv2.png",
    "https://static.wixstatic.com/media/3da789_eb82f3ec8aa945bf971e1c4c72649ca5~mv2.png",
    "https://static.wixstatic.com/media/3da789_cfed9a1f72c64f40807dbbc3188fe94f~mv2.png",
    "https://static.wixstatic.com/media/3da789_1b214a33d2eb4c4c960879cc1877aa0a~mv2.png",
    "https://static.wixstatic.com/media/3da789_1b3a189886454ebdb3daf567addb9dd3~mv2.png",
    "https://static.wixstatic.com/media/3da789_d2a62964ceb7482cb9a723d779253c10~mv2.png",
    "https://static.wixstatic.com/media/3da789_9357360413ea4a27bd2a61b1c525633f~mv2.png",
    "https://static.wixstatic.com/media/3da789_7f803582ce514d79ad7c78500f6c828e~mv2.png",
    "https://static.wixstatic.com/media/3da789_0e79a83e7e604ca68f90977fedb0658c~mv2.png",
    "https://static.wixstatic.com/media/3da789_4d37a3ebef544e9abd96f8e3371deae7~mv2.png",
    "https://static.wixstatic.com/media/3da789_51accceea8c64611bae43f2d062186bd~mv2.png",
    "https://static.wixstatic.com/media/3da789_139bcc80ed08475b8ff1bee4112e4caf~mv2.png",
    "https://static.wixstatic.com/media/3da789_e0770ec0e97c47708fb00f83d06d8a80~mv2.jpeg",
  ];
  const splashImage = SPLASH_IMAGES[Math.floor(Math.random() * SPLASH_IMAGES.length)];
  // --- Splash Screen ---
  const [showSplash, setShowSplash] = useState(false);

  // --- Zugangsschutz ---
  const VALID_PASSWORDS = [
    "MStH992324",
  ];

  const checkAccess = () => {
    // Alter localStorage-Trial (Passwort + 14-Tage-Zähler) ist Geschichte:
    // Zugang regeln jetzt ausschließlich Login + Rollen (Mitglied/Pro/V.I.P./Mod/Admin).
    // Deshalb hier immer "granted" — so erscheinen weder das "noch X Tage kostenlos"-
    // Banner noch die "Probezeit abgelaufen"-Sperre. (Umkehrbar: alte Logik unten als Kommentar.)
    return "granted";
    /* früher:
    try {
      const pw = localStorage.getItem("lenormand_pw");
      if (VALID_PASSWORDS.includes(pw)) return "granted";
      const first = localStorage.getItem("lenormand_first");
      if (!first) {
        localStorage.setItem("lenormand_first", new Date().toISOString());
        return "trial";
      }
      const days = (Date.now() - new Date(first).getTime()) / 86400000;
      if (days < 14) return "trial";
      return "expired";
    } catch { return "trial"; }
    */
  };
  const [access, setAccess] = useState(checkAccess);
  const [pwInput, setPwInput] = useState("");
  const [pwError, setPwError] = useState(false);

  const tryPassword = () => {
    if (VALID_PASSWORDS.includes(pwInput.trim())) {
      try { localStorage.setItem("lenormand_pw", pwInput.trim()); } catch {}
      setAccess("granted");
      setPwError(false);
    } else {
      setPwError(true);
    }
  };

  const getDaysLeft = () => {
    try {
      const first = localStorage.getItem("lenormand_first");
      if (!first) return 14;
      const days = Math.floor((Date.now() - new Date(first).getTime()) / 86400000);
      return Math.max(0, 14 - days);
    } catch { return 14; }
  };

  const [matrixView, setMatrixView] = useState("question"); // question | signifikator | layout | result
  const [question, setQuestion] = useState("");
  const [randomMode, setRandomMode] = useState(false);
  // Quiz state
  const [quizMode, setQuizMode] = useState("kombis");
  const [comboView, setComboView] = useState("2er");
  const [comboSelected, setComboSelected] = useState([]);
  const [quizCards, setQuizCards] = useState(null);
  const [quizAnswer, setQuizAnswer] = useState(null);
  const [quizScore, setQuizScore] = useState({right:0, wrong:0});
  const [currentStreak, setCurrentStreak] = useState(0);
  const [showConfetti, setShowConfetti] = useState(false);
  const [trainMode, setTrainMode] = useState(false);
  const [trainRevealed, setTrainRevealed] = useState(false);

  // Highscore from localStorage
  const loadStats = () => {
    try {
      const s = JSON.parse(localStorage.getItem("lenormand_stats") || "{}");
      const today = new Date().toDateString();
      return {
        bestScore: s.bestScore || {kombis:0, zeit:0, person:0, karte:0, "3er":0, "4er":0},
        todayRight: s.lastPlayed === today ? (s.todayRight || 0) : 0,
        todayTotal: s.lastPlayed === today ? (s.todayTotal || 0) : 0,
        streakDays: s.streakDays || 0,
        lastPlayed: s.lastPlayed || null
      };
    } catch { return {bestScore:{kombis:0,zeit:0,person:0}, todayRight:0, todayTotal:0, streakDays:0, lastPlayed:null}; }
  };
  const [stats, setStats] = useState(loadStats);

  const saveStats = (newStats) => {
    try { localStorage.setItem("lenormand_stats", JSON.stringify(newStats)); } catch {}
    setStats(newStats);
  };

  const updateStats = (isCorrect, sessionRight, sessionTotal) => {
    const today = new Date().toDateString();
    const s = loadStats();
    const lastDay = s.lastPlayed;
    const yesterday = new Date(Date.now() - 86400000).toDateString();
    
    let streakDays = s.streakDays || 0;
    if (lastDay === today) {
      // already played today, streak unchanged
    } else if (lastDay === yesterday) {
      streakDays += 1;
    } else {
      streakDays = 1;
    }

    const todayRight = (lastDay === today ? (s.todayRight || 0) : 0) + (isCorrect ? 1 : 0);
    const todayTotal = (lastDay === today ? (s.todayTotal || 0) : 0) + 1;

    const prevBest = s.bestScore || {kombis:0, zeit:0, person:0, karte:0, "3er":0, "4er":0};
    const newBest = typeof prevBest === 'number' 
      ? {kombis: prevBest, zeit: prevBest, person: prevBest}
      : {...prevBest};
    const modeKey = quizMode || "kombis";
    const wasBest = newBest[modeKey] || 0;
    newBest[modeKey] = Math.max(wasBest, sessionRight);
    const newHighscore = newBest[modeKey] > wasBest && sessionRight > 0;
    const newS = {
      bestScore: newBest,
      newHighscore,
      todayRight,
      todayTotal,
      streakDays,
      lastPlayed: today
    };
    saveStats(newS);
    // Neuen persönlichen Highscore automatisch in den Aktivitäts-Stream legen (nur eingeloggt).
    if (newHighscore) {
      const uid = getUserId();
      if (uid) {
        fetch(`${SUPABASE_URL}/rest/v1/activity_events`, {
          method: "POST", headers: {...dbHeaders(), "Prefer": "return=minimal"},
          body: JSON.stringify({ user_id: uid, display_name: userDisplayName || "Mitglied", kind: "quiz_highscore", payload: { score: newBest[modeKey], mode: modeKey } })
        }).catch(() => {});
      }
    }
  };
  const [signifikator, setSignifikator] = useState(null);
  const [writingMode, setWritingMode] = useState("situation"); // "situation" | "personen" — welche Matrix für die Textdeutung im Writing-Bereich genutzt wird
  const [matrixCards, setMatrixCards] = useState(Array(9).fill(null)); // 9 positions, pos 4 = signifikator
  // Eigene, separate States für die optionale Intro-/Outro-Karte im Writing-Bereich —
  // bewusst NICHT Teil von matrixCards, damit der echte Matrix-Bereich (der überall von
  // einer festen 9er-Länge ausgeht) unangetastet bleibt.
  const [introCard, setIntroCard] = React.useState(null);
  const [outroCard, setOutroCard] = React.useState(null);
  const [activePos, setActivePos] = useState(null); // which position is being filled
  const [matrixFreeText, setMatrixFreeText] = useState({}); // { [pos]: "freier Text statt Karte" } — für die freie Matrix beim Karten-Wählen
  const [pickerMode, setPickerMode] = useState("karte"); // "karte" | "freitext" — was im Karten-Picker gerade angeboten wird

  // Liest/schreibt die Karte für eine Picker-Position — das kann entweder eine echte
  // Matrix-Position (0-8, in matrixCards) oder "intro"/"outro" (eigene States) sein.
  // So kann der bestehende Picker-Code unverändert weiterlaufen und trotzdem Intro/Outro
  // mit bedienen, ohne dass matrixCards selbst seine feste 9er-Länge verliert.
  const getCardForPos = (pos) => {
    if (pos === "intro") return introCard;
    if (pos === "outro") return outroCard;
    return matrixCards ? matrixCards[pos] : null;
  };
  const setCardForPos = (pos, num) => {
    if (pos === "intro") { setIntroCard(num); return; }
    if (pos === "outro") { setOutroCard(num); return; }
    const newCards = [...(matrixCards || Array(9).fill(null))];
    newCards[pos] = num;
    setMatrixCards(newCards);
  };

  // Beim Verlassen der Seite / Tab-Wechsel sofort speichern, statt auf den Debounce-Timer zu warten
  React.useEffect(() => {
    const flush = () => {
      if (writingTimer.current) {
        clearTimeout(writingTimer.current);
        saveProject();
      }
    };
    window.addEventListener("beforeunload", flush);
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flush(); });
    return () => {
      window.removeEventListener("beforeunload", flush);
    };
  }, [writingNotes, writingProjekt, writingBemerkung, writingHook, matrixCards, signifikator]);

  const reset = () => {
    setSelected([]); setSearch(""); setCardDetail(null);
    setSignifikator(null); setMatrixCards(Array(9).fill(null));
    setActivePos(null); setMatrixView("question"); setQuestion(""); setRandomMode(false);
  };

  const filteredCards = (exclude=[]) => CARD_NUMS.filter(n => {
    if (exclude.includes(n)) return false;
    const name = CARDS[n].name.toLowerCase();
    const kw = CARDS[n].kw.toLowerCase();
    const s = search.toLowerCase();
    return !s || name.includes(s) || kw.includes(s) || String(n) === s;
  });

  // -- PICKER VIEW --
  const toggleCard = (num) => {
    setSelected(prev => {
      if (prev.includes(num)) return prev.filter(n => n !== num);
      if (prev.length >= 2) return [prev[1], num];
      return [...prev, num];
    });
  };
  const showResult = selected.length === 2 ? getCombo(selected[0], selected[1]) : null;

  // -- MATRIX VIEW --
  const selectSignifikator = (num) => {
    setSignifikator(num);
    const newCards = Array(9).fill(null);
    newCards[4] = num;
    setMatrixCards(newCards);
    setMatrixView("layout");
  };

  const randomLayout = () => {
    if (!signifikator) return;
    const pool = CARD_NUMS.filter(n => n !== signifikator);
    const shuffled = [...pool].sort(() => Math.random() - 0.5);
    const newCards = Array(9).fill(null);
    newCards[4] = signifikator;
    const positions = [0,1,2,3,5,6,7,8];
    positions.forEach((pos, i) => { newCards[pos] = shuffled[i]; });
    setMatrixCards(newCards);
    setActivePos(null);
  };

  const fullRandom = () => {
    const shuffled = [...CARD_NUMS].sort(() => Math.random() - 0.5);
    const sig = shuffled[0];
    const newCards = Array(9).fill(null);
    newCards[4] = sig;
    const positions = [0,1,2,3,5,6,7,8];
    positions.forEach((pos, i) => { newCards[pos] = shuffled[i+1]; });
    setSignifikator(sig);
    setMatrixCards(newCards);
    setActivePos(null);
    setMatrixView("result");
    setRandomMode(false);
  };

  const writingRandom = () => {
    const shuffled = [...CARD_NUMS].sort(() => Math.random() - 0.5);
    const sig = shuffled[0];
    const newCards = Array(9).fill(null);
    newCards[4] = sig;
    const positions = [0,1,2,3,5,6,7,8];
    positions.forEach((pos, i) => { newCards[pos] = shuffled[i+1]; });
    setSignifikator(sig);
    setMatrixCards(newCards);
    // Neue Session beginnt ohne Intro-/Outro-Karte — die werden bewusst separat gewählt
    setIntroCard(null);
    setOutroCard(null);
  };

  const startZeitQuiz = () => {
    const keys = Object.keys(TIME_QUIZ);
    const shuffled = [...keys].sort(() => Math.random() - 0.5);
    const correctKey = shuffled[0];
    const correct = TIME_QUIZ[correctKey];
    const wrongKeys = shuffled.slice(1, 4);
    const options = [correct, ...wrongKeys.map(k => TIME_QUIZ[k])].sort(() => Math.random() - 0.5);
    setQuizCards({c1: parseInt(correctKey), c2: null, correct, options, mode: "zeit"});
    setQuizAnswer(null);
  };

  const startPersonQuiz = () => {
    const keys = Object.keys(PERSON_SIG);
    const shuffled = [...keys].sort(() => Math.random() - 0.5);
    const correctKey = shuffled[0];
    const correct = PERSON_SIG[correctKey];
    const wrongKeys = shuffled.slice(1, 4);
    const options = [correct, ...wrongKeys.map(k => PERSON_SIG[k])].sort(() => Math.random() - 0.5);
    setQuizCards({c1: parseInt(correctKey), c2: null, correct, options, mode: "person"});
    setQuizAnswer(null);
  };

  const startKarteQuiz = () => {
    const keys = Object.keys(CARDS);
    const shuffled = [...keys].sort(() => Math.random() - 0.5);
    const correctKey = shuffled[0];
    const correct = CARDS[correctKey].kw;
    const wrongKeys = shuffled.slice(1, 4);
    const options = [correct, ...wrongKeys.map(k => CARDS[k].kw)].sort(() => Math.random() - 0.5);
    setQuizCards({c1: parseInt(correctKey), c2: null, correct, options, mode: "karte"});
    setQuizAnswer(null);
    setTrainRevealed(false);
  };

  const start3erQuiz = () => {
    const all = CLUSTERS["3er"];
    const shuffled = [...all].sort(() => Math.random() - 0.5);
    const correct = shuffled[0];
    const wrongOptions = shuffled.slice(1, 4).map(c => c.text);
    const options = [correct.text, ...wrongOptions].sort(() => Math.random() - 0.5);
    setQuizCards({c1: correct.karten[0], c2: correct.karten[1], correct: correct.text, options, mode: "3er", label: correct.label, karten: correct.karten});
    setQuizAnswer(null);
    setTrainRevealed(false);
  };

  const start4erQuiz = () => {
    const all = CLUSTERS["4er"];
    const shuffled = [...all].sort(() => Math.random() - 0.5);
    const correct = shuffled[0];
    const wrong3er = [...CLUSTERS["3er"]].sort(() => Math.random() - 0.5).slice(0, 3).map(c => c.text);
    const wrongOptions = [...shuffled.slice(1).map(c => c.text), ...wrong3er].slice(0, 3);
    const options = [correct.text, ...wrongOptions].sort(() => Math.random() - 0.5);
    setQuizCards({c1: correct.karten[0], c2: correct.karten[1], correct: correct.text, options, mode: "4er", label: correct.label, karten: correct.karten});
    setQuizAnswer(null);
    setTrainRevealed(false);
  };

  // "Kombinationen" fasst 2er/3er/4er zu einem gemeinsamen Quiz-Punkt zusammen — bei
  // jeder neuen Frage wird zufällig nach festen Anteilen entschieden (70% 2er, 20% 3er,
  // 10% 4er), damit 2er weiterhin am häufigsten vorkommt, aber 3er/4er spürbar und nicht
  // nur homöopathisch selten mit dabei sind.
  const startKombinationenQuiz = () => {
    const r = Math.random();
    if (r < 0.70) startQuiz();
    else if (r < 0.90) start3erQuiz();
    else start4erQuiz();
  };

  const startCurrentQuiz = () => {
    setTrainRevealed(false);
    if (quizMode === "kombis") startKombinationenQuiz();
    else if (quizMode === "zeit") startZeitQuiz();
    else if (quizMode === "person") startPersonQuiz();
    else startKarteQuiz();
  };

  const trimCombo = (text) => {
    if (!text) return "";
    // Take only first 2 sentences max, clean whitespace
    const clean = text.replace(/\s+/g, ' ').trim();
    const sentences = clean.match(/[^.!?]+[.!?]+/g) || [clean];
    return sentences.slice(0, 2).join(' ').trim();
  };

  const startQuiz = () => {
    const shuffled = [...CARD_NUMS].sort(() => Math.random() - 0.5);
    const [a, b] = [shuffled[0], shuffled[1]];
    const [c1, c2] = Math.random() > 0.5 ? [a, b] : [b, a];
    const lo = Math.min(c1,c2), hi = Math.max(c1,c2);
    const correct = trimCombo(COMBOS[lo+"-"+hi] || "");
    const wrongKeys = Object.keys(COMBOS)
      .filter(k => k !== lo+"-"+hi)
      .sort(() => Math.random() - 0.5)
      .slice(0, 3);
    const options = [correct, ...wrongKeys.map(k => trimCombo(COMBOS[k]))]
      .sort(() => Math.random() - 0.5);
    setQuizCards({c1, c2, correct, options});
    setQuizAnswer(null);
  };

  const startRandom = () => {
    setView("fragmich");
    setMode("situation");
    setMatrixView("question");
    setRandomMode(true);
    setSignifikator(null);
    setMatrixCards(Array(9).fill(null));
    setActivePos(null);
    setQuestion("");
  };

  const placeCard = (num) => {
    if (activePos === null) return;
    const newCards = [...matrixCards];
    // Remove from other positions first
    for (let i = 0; i < 9; i++) {
      if (newCards[i] === num && i !== 4) newCards[i] = null;
    }
    newCards[activePos] = num;
    setMatrixCards(newCards);
    setActivePos(null);
  };

  const allFilled = matrixCards.every(c => c !== null);
  const usedCards = matrixCards.filter(Boolean);

  // Liefert den festen Positions-Text für die Karte, die auf "pos" liegt — NICHT für
  // den Signifikator! Beispiel: liegt bei "Gedanken" die Karte "Mäuse", kommt der
  // gendanken-Text von Mäuse, unabhängig davon welcher Signifikator gewählt wurde.
  const getMatrixText = (pos) => {
    const cardOnPos = matrixCards[pos];
    if (!cardOnPos) return null;
    if (writingMode === "personen") {
      const pm = PERSON_MATRIX[String(cardOnPos)];
      if (!pm) return null;
      const perKeys = ["sternzeichen", "haarfarbe", "charakter", "figur", null, "beruf", "groesse", "alter", "woher"];
      return perKeys[pos] ? pm[perKeys[pos]] : null;
    }
    const m = MATRIX[String(cardOnPos)];
    if (!m) return null;
    const keys = ["gendanken", null, "rat_der_engel", "warnung", null, null, "wo_es_herkommt", null, "ergebnis_und_wann"];
    return keys[pos] ? m[keys[pos]] : null;
  };

  // Liefert den Inspirationstext für eine Writing-Position: bei Positionen mit comboWith
  // die Kombination zwischen Signifikator und der dort gewählten Karte, sonst den festen
  // Matrix-Text (Situations- oder Personen-Matrix, je nach writingMode).
  const getInspirationText = (pos, comboWith, cardNum) => {
    if (comboWith !== null) {
      if (!signifikator || !cardNum) return null;
      return getCombo(signifikator, cardNum);
    }
    return getMatrixText(pos);
  };

  const getPositionContent = (pos) => {
    const card = matrixCards[pos];
    if (pos === 4) {
      // Signifikator
      if (!card) return null;
      return { type: "signifikator", card };
    }
    if (KOMBI_POSITIONS.includes(pos)) {
      if (!card || !signifikator) return { type: "empty_kombi" };
      const combo = getCombo(signifikator, card);
      return { type: "kombi", card, text: combo };
    }
    // Fixed text position
    const text = getMatrixText(pos);
    return { type: "text", card, text };
  };

  const dim = "rgba(200,169,110,0.12)";
  const bg = "rgba(10,7,18,0.95)";

  const CardMini = ({num, size=22}) => num ? (
    <span style={{fontSize:size}}>{SYMBOLS[num]}</span>
  ) : null;

  // Findet YouTube-Links in einem Text (normale Videos, Shorts und youtu.be-Kurzlinks)
  // und liefert die Video-ID — wird genutzt, um Lektionen/Beiträge mit Videotext automatisch
  // als großes eingebettetes Video darzustellen, statt nur als rohen Link.
  const extractYoutubeId = (url) => {
    const m = url.match(/(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([a-zA-Z0-9_-]{6,})/);
    return m ? m[1] : null;
  };

  // Erkennt Instagram-Reels (und normale Posts/IGTV) und liefert Typ + Kürzel, damit
  // sie als eingebettetes Video statt als roher Link erscheinen. "reels" wird auf "reel"
  // normalisiert; der Typ bleibt erhalten, damit die Embed-URL passt (reel/p/tv).
  const extractInstagram = (url) => {
    const m = url.match(/instagram\.com\/(reel|reels|p|tv)\/([A-Za-z0-9_-]+)/);
    if (!m) return null;
    return { type: m[1] === "reels" ? "reel" : m[1], code: m[2] };
  };

  // Zerlegt einen Beitrags-/Antworttext in normale Textabschnitte und YouTube-Links,
  // und rendert Letztere als großes eingebettetes Video (gleiche Optik wie auf der Willkommensseite).
  // Erkennt GIF-Links (auch mit Query-Parametern dahinter, wie bei Tenor/Giphy-Links üblich)
  const isGifUrl = (url) => /\.gif(\?.*)?$/i.test(url);
  // Giphy-Seitenlinks (giphy.com/gifs/... oder /embed/...) einbetten — viele fügen den
  // Seiten-Link ein statt der direkten .gif-Datei. Wir ziehen die ID heraus.
  const extractGiphyId = (url) => {
    const m = url.match(/giphy\.com\/(?:gifs|embed|clips)\/(?:[^/?#]*-)?([A-Za-z0-9]+)/i);
    return m ? m[1] : null;
  };
  // Direkte Videodateien (mp4/webm/ogg/mov) — werden wie ein Video mit Steuerung eingebettet.
  const isVideoFileUrl = (url) => /\.(mp4|webm|ogg|mov)(\?.*)?$/i.test(url);
  // Erkennt normale Bild-Links (jpg/jpeg/png/webp/svg), genau wie isGifUrl — als
  // Übergangslösung, bis es einen echten Bild-Upload gibt. Funktioniert mit jedem Link
  // zu einer Bilddatei, der im Text steht (z.B. von einem eigenen Hosting), nicht nur
  // mit Links, die man selbst hochgeladen hat.
  const isImageUrl = (url) => /\.(jpe?g|png|webp|svg)(\?.*)?$/i.test(url);

  const renderTextWithVideos = (text) => {
    if (!text) return null;
    const urlPattern = /(https?:\/\/[^\s]+)/g;
    const parts = text.split(urlPattern);
    return parts.map((part, i) => {
      const isUrl = /^https?:\/\//.test(part);
      const videoId = isUrl ? extractYoutubeId(part) : null;
      if (videoId) {
        return (
          <div key={i} style={{ borderRadius:10, overflow:"hidden", margin:"10px 0", position:"relative", paddingTop:"56.25%" }}>
            <iframe
              src={`https://www.youtube.com/embed/${videoId}`}
              title="Video"
              style={{ position:"absolute", top:0, left:0, width:"100%", height:"100%", border:"none" }}
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
              allowFullScreen
            />
          </div>
        );
      }
      // Instagram-Reels (und Posts/IGTV) direkt einbetten — hochkant, mittig, wie ein Reel.
      const ig = isUrl ? extractInstagram(part) : null;
      if (ig) {
        return (
          <div key={i} style={{ display:"flex", justifyContent:"center", margin:"10px 0" }}>
            <iframe
              src={`https://www.instagram.com/${ig.type}/${ig.code}/embed`}
              title="Reel"
              scrolling="no"
              style={{ width:"100%", maxWidth:400, height:580, border:"none", borderRadius:10, background:"#000" }}
              allow="encrypted-media; clipboard-write; picture-in-picture"
              allowFullScreen
            />
          </div>
        );
      }
      // GIFs werden direkt eingebettet und spielen automatisch ab — wirkt wie ein kleines
      // Video, macht das Forum lebendiger statt nur einen Link anzuzeigen.
      if (isUrl && isGifUrl(part)) {
        return (
          <img key={i} src={part} alt="GIF" loading="lazy"
            style={{ maxWidth:"100%", borderRadius:10, margin:"10px 0", display:"block" }} />
        );
      }
      // Giphy-Seitenlinks als eingebettetes GIF anzeigen.
      const giphyId = isUrl ? extractGiphyId(part) : null;
      if (giphyId) {
        return (
          <div key={i} style={{ margin:"10px 0", borderRadius:10, overflow:"hidden" }}>
            <iframe src={`https://giphy.com/embed/${giphyId}`} title="GIF"
              style={{ width:"100%", height:280, border:"none" }} allowFullScreen />
          </div>
        );
      }
      // Direkte Videodateien einbetten (mp4/webm/…) — mit Steuerung, spielt inline.
      if (isUrl && isVideoFileUrl(part)) {
        return (
          <video key={i} src={part} controls playsInline loading="lazy"
            style={{ maxWidth:"100%", borderRadius:10, margin:"10px 0", display:"block" }} />
        );
      }
      // Normale Bild-Links genauso direkt einbetten — Übergangslösung bis es echten
      // Bild-Upload gibt. Klick auf das Bild öffnet es in voller Größe in neuem Tab.
      if (isUrl && isImageUrl(part)) {
        return (
          <a key={i} href={part} target="_blank" rel="noopener noreferrer" style={{ display:"block", margin:"10px 0" }}>
            <img src={part} alt="Bild" loading="lazy"
              style={{ maxWidth:"100%", borderRadius:10, display:"block" }} />
          </a>
        );
      }
      // Normale Links (z.B. zur Pro-Mitgliedschafts-Seite) werden klickbar dargestellt,
      // statt nur als unscheinbarer Text stehen zu bleiben.
      if (isUrl) {
        return (
          <a key={i} href={part} target="_blank" rel="noopener noreferrer"
            style={{ color:gold, textDecoration:"underline", wordBreak:"break-all" }}>
            {part}
          </a>
        );
      }
      return part ? <span key={i} style={{whiteSpace:"pre-wrap"}}>{part}</span> : null;
    });
  };

  // Rang/Titel anhand der Beitragszahl — Annas eigene Staffelung mit Emoji vor dem Titel.
  const forumRankForPostCount = (count) => {
    if (count > 1000) return "🗿 Urgestein";
    if (count >= 801) return "🌙 Alte Seele";
    if (count >= 501) return "🐉 Schreib Monster";
    if (count >= 201) return "✨ Magisches Wesen";
    if (count >= 101) return "🗝️ Geheimniskrämer";
    if (count >= 51) return "🔑 Insider";
    if (count >= 26) return "📜 Wort Weise";
    if (count >= 11) return "🦉 Wissendes Wesen";
    if (count >= 6) return "🔍 Spürnase";
    return "🌱 Newbie";
  };

  // Berechnet aus einem Geburtsdatum das aktuelle Alter als kurzes Label, z.B. "57j".
  // Kein Geburtsdatum hinterlegt -> leerer String, dann erscheint im Profil/Beitrag
  // einfach nichts dazu (kein Pflichtfeld).
  const ageFromBirthdate = (birthdate) => {
    if (!birthdate) return "";
    const b = new Date(birthdate);
    if (isNaN(b.getTime())) return "";
    const today = new Date();
    let age = today.getFullYear() - b.getFullYear();
    const hasHadBirthdayThisYear = (today.getMonth() > b.getMonth()) || (today.getMonth() === b.getMonth() && today.getDate() >= b.getDate());
    if (!hasHadBirthdayThisYear) age -= 1;
    return age >= 0 ? `${age}j` : "";
  };

  const forumRoleLabel = (role) => {
    if (role === "admin") return "Admin";
    if (role === "mod") return "Moderator";
    if (role === "pro_full") return "V.I.P.";
    if (role === "pro") return "Pro";
    return "Mitglied";
  };

  // Wiederverwendbares Daily-Untermenü (Tageskarten/Zauberzettel/Writing/Quest).
  const DailySubNav = () => (
    <div style={{ display:"flex", justifyContent:"center", gap:8, marginBottom:20, overflowX:"auto", WebkitOverflowScrolling:"touch", paddingBottom:4, paddingLeft:2, paddingRight:2 }}>
      {[["tagebuch","📓 Tageskarten"],["manifest","✨ Zauberzettel"],["writing","✍️ Writing"],["quest","🎯 Quest"]].map(([m,l]) => {
        const isActive = dailyMode === m && view === "tagebuch";
        return (
          <button key={m} onClick={() => {
              setView("tagebuch"); setDailyMode(m); setTagebuchView("tagebuch"); setKlientName(""); setKlientGeburt(""); setTippVisible(false); setWritingView("projekt");
            }}
            style={{ background:isActive?(lightMode?"rgba(200,168,224,0.18)":"rgba(200,169,110,0.15)"):"rgba(200,169,110,0.03)", border:`1px solid ${isActive?(lightMode?"#c8a8e0":gold):"rgba(200,169,110,0.2)"}`, color:isActive?gold:"#7a6040", padding:"7px 14px", borderRadius:8, cursor:"pointer", fontSize:11, fontFamily:"Georgia,serif", letterSpacing:0.5, transition:"all 0.2s", whiteSpace:"nowrap", flexShrink:0 }}>
            {l}
          </button>
        );
      })}
    </div>
  );

  // Wiederverwendbares Forum-Untermenü (Profil/Forum/Kurse/Quiz) — wird sowohl im
  // normalen Forum-Bereich (view==="forum") als auch im Quiz selbst (view==="quiz", ein
  // eigener View-Wert) eingebunden, damit man von beiden Seiten aus konsistent wechseln
  // kann, ohne dass das Untermenü beim Quiz-Klick verschwindet.
  const ForumSubNav = () => {
    const items = [
      { key:"stream", label:"🌊 Stream", active: view==="forum" && communityMode==="forum" && forumStartTab==="stream",
        onClick: () => { setView("forum"); setCommunityMode("forum"); setForumStartTab("stream"); setForumView("liste"); setForumActiveCategory(null); setForumActivePost(null); } },
      ...(isAdmin ? [{ key:"kategorie", label:"📁 Kategorie", active: view==="forum" && communityMode==="forum" && forumStartTab==="kategorien",
        onClick: () => { setView("forum"); setCommunityMode("forum"); setForumStartTab("kategorien"); setForumView("liste"); setForumActiveCategory(null); setForumActivePost(null); } }] : []),
      { key:"profil", label:"👤 Profil", active: view==="forum" && communityMode==="profil",
        onClick: () => { setView("forum"); setCommunityMode("profil"); } },
      { key:"kurse", label:"🎓 Kurse", active: view==="forum" && communityMode==="kurse",
        onClick: () => { setView("forum"); setCommunityMode("kurse"); } },
      { key:"quiz", label:"🎓 Quiz", active: view==="quiz",
        onClick: () => { setView("quiz"); setQuizCards(null); setQuizAnswer(null); setQuizScore({right:0,wrong:0}); setCurrentStreak(0); } },
    ];
    return (
      <div style={{ display:"flex", justifyContent:"flex-start", gap:8, marginBottom:8, overflowX:"auto", WebkitOverflowScrolling:"touch", paddingBottom:4, paddingLeft:2, paddingRight:2 }}>
        {items.map(it => (
          <button key={it.key} onClick={it.onClick}
            style={{ background:it.active?(lightMode?"rgba(200,168,224,0.18)":"rgba(200,169,110,0.15)"):"rgba(200,169,110,0.03)", border:`1px solid ${it.active?(lightMode?"#c8a8e0":gold):"rgba(200,169,110,0.2)"}`, color:it.active?gold:"#7a6040", padding:"7px 14px", borderRadius:8, cursor:"pointer", fontSize:11, fontFamily:"Georgia,serif", letterSpacing:0.5, transition:"all 0.2s", whiteSpace:"nowrap", flexShrink:0 }}>
            {it.label}
          </button>
        ))}
      </div>
    );
  };

  // Wiederverwendbare Statistik-Zeile (alle Mitglieder, alle Beiträge inkl. Antworten,
  // heute aktiv) — wird auf jeder Forum-Unterseite unten eingebunden, nicht nur in der
  // Kategorien-Übersicht. Greift auf den forumStats-State zu, der in loadForumCategories()
  // berechnet wird.
  const ForumStatsBar = () => (
    <div style={{ display:"flex", justifyContent:"center", gap:24, marginTop:24, paddingTop:16, borderTop:`1px solid ${lightMode?"rgba(80,30,120,0.3)":"rgba(200,169,110,0.12)"}`, flexWrap:"wrap" }}>
      <div style={{ textAlign:"center" }}>
        <div style={{ fontSize:18, color:gold }}>🌙 {forumStats.totalMembers.toLocaleString('de-DE')}</div>
        <div style={{ fontSize:9, color:lightMode?"#2a0850":"#7a6040", letterSpacing:1, textTransform:"uppercase" }}>Alle Mitglieder</div>
      </div>
      <div style={{ textAlign:"center" }}>
        <div style={{ fontSize:18, color:gold }}>📔 {forumStats.totalPosts.toLocaleString('de-DE')}</div>
        <div style={{ fontSize:9, color:lightMode?"#2a0850":"#7a6040", letterSpacing:1, textTransform:"uppercase" }}>Alle Beiträge</div>
      </div>
      <div style={{ textAlign:"center" }}>
        <div style={{ fontSize:18, color:gold }}>✨ {forumStats.activeToday.toLocaleString('de-DE')}</div>
        <div style={{ fontSize:9, color:lightMode?"#2a0850":"#7a6040", letterSpacing:1, textTransform:"uppercase" }}>Heute aktiv</div>
      </div>
      <div style={{ textAlign:"center" }}>
        <div style={{ fontSize:18, color:gold }}>🌱 {forumStats.newToday.toLocaleString('de-DE')}</div>
        <div style={{ fontSize:9, color:lightMode?"#2a0850":"#7a6040", letterSpacing:1, textTransform:"uppercase" }}>Heutige Neuanmeldungen</div>
      </div>
    </div>
  );

  // Kleine Profilkarte vor jedem Beitrag/jeder Antwort: Name, Rolle, Rang, Mitglied seit.
  // Schmale linke Profil-Spalte (Avatar-Platzhalter mit Initiale, Name, Rolle, Rang,
  // Mitglied seit) — wird neben den Beitragstext gesetzt, wie in einem klassischen Forum.
  const ForumProfileTag = ({ userId, displayName }) => {
    const p = userId ? forumProfiles[userId] : null;
    const rank = forumRankForPostCount(p?.postCount || 0);
    const initial = (displayName || "?").trim().charAt(0).toUpperCase() || "?";
    const age = ageFromBirthdate(p?.birthdate);
    // Nur klickbar, wenn es eine echte userId gibt — Gast-/Anonym-Beiträge haben keine
    // und sollen nicht zu einem leeren Profil führen.
    const clickable = !!userId;
    return (
      <div onClick={() => { if (clickable) { setViewedProfileId(userId); setViewedProfileName(displayName); } }}
        style={{ display:"flex", flexDirection:"column", alignItems:"center", width:78, flexShrink:0, textAlign:"center", gap:4, cursor:clickable?"pointer":"default" }}>
        <div style={{ width:44, height:44, borderRadius:"50%", background:"rgba(200,169,110,0.12)", border:`1px solid ${gold}`, display:"flex", alignItems:"center", justifyContent:"center", fontSize:18, color:gold, fontFamily:"Georgia,serif" }}>
          {initial}
        </div>
        <span style={{ fontSize:11, color:gold, lineHeight:1.2 }}>{displayName}{age && <span style={{ color:lightMode?"#2a0850":"#9a8060", fontSize:9 }}> · {age}</span>}</span>
        {p && (
          <>
            <span style={{ fontSize:8, color:lightMode?"#2a0850":"#7a6040", background:"rgba(200,169,110,0.08)", padding:"2px 6px", borderRadius:8 }}>{forumRoleLabel(p.role)}</span>
            <span style={{ fontSize:9, color:gold, lineHeight:1.3 }}>{rank}</span>
            {p.createdAt && <span style={{ fontSize:7, color:lightMode?"#2a0850":"#5a4a34", lineHeight:1.3 }}>seit {new Date(p.createdAt).toLocaleDateString('de-DE', {month:"short", year:"numeric"})}</span>}
          </>
        )}
      </div>
    );
  };

  // Stellt eine Antwort + alle ihre verschachtelten Unter-Antworten dar (rekursiv, mit
  // wachsendem Einzug pro Ebene). depth steuert den Einzug, maxDepth begrenzt ihn nach
  // unten hin, damit es auf schmalen Bildschirmen nicht zu eng wird.
  const ForumReplyThread = ({ reply, allReplies, depth }) => {
    const children = allReplies.filter(r => r.reply_to_id === reply.id);
    const indent = Math.min(depth, 4) * 22;
    const isEditing = forumEditingReplyId === reply.id;
    return (
      <div style={{ marginLeft: indent }}>
        <div style={{ background:"rgba(200,169,110,0.02)", border:`1px solid ${lightMode?"rgba(80,30,120,0.3)":"rgba(200,169,110,0.12)"}`, borderRadius:8, padding:"10px 14px", marginBottom:8 }}>
          {isEditing ? (
            <InlineEditBox lightMode={lightMode}
              initialValue={reply.body}
              onSave={(newBody) => saveEditForumReply(reply.id, newBody)}
              onCancel={() => setForumEditingReplyId(null)}
            />
          ) : (<>
            <div style={{ display:"flex", justifyContent:"flex-end", gap:8 }}>
              {forumCanEdit(reply, reply.user_id) && (
                <button onClick={() => startEditForumReply(reply)} style={{ background:"transparent", border:"none", color:lightMode?"#2a0850":"#9a8060", cursor:"pointer", fontSize:11 }}>✎</button>
              )}
              {(isMod || reply.user_id === getUserId()) && (
                <button onClick={() => deleteForumReply(reply.id)} style={{ background:"transparent", border:"none", color:"#9a6050", cursor:"pointer", fontSize:11 }}>✕</button>
              )}
            </div>
            <div style={{ display:"flex", gap:12 }}>
              <ForumProfileTag userId={reply.user_id} displayName={reply.display_name} />
              <div style={{ flex:1, minWidth:0 }}>
                <div style={{ fontSize:9, color:lightMode?"#2a0850":"#5a4a34", marginBottom:4 }}>{new Date(reply.created_at).toLocaleDateString('de-DE')}</div>
                <div style={{ fontSize:13, color:lightMode?"#2a0850":"#d4c4a0", lineHeight:1.6, marginBottom:6 }}>{renderTextWithVideos(reply.body)}</div>
                {(() => {
                  const sig = reply.user_id === getUserId()
                    ? userSignature
                    : forumProfiles[reply.user_id]?.signature;
                  return sig ? (
                    <div style={{ marginBottom:6, paddingTop:6, borderTop:`1px solid ${lightMode?"rgba(80,30,120,0.3)":"rgba(200,169,110,0.08)"}`, fontSize:10, color:lightMode?"#2a0850":"#7a6040", fontStyle:"italic" }}>{sig}</div>
                  ) : null;
                })()}
                <div style={{ display:"flex", gap:14, alignItems:"center" }}>
                  <button onClick={() => toggleForumReplyLike(reply.id)}
                    style={{ background:"transparent", border:"none", color:forumMyLikes[reply.id]?gold:"#9a8060", cursor:"pointer", fontSize:11, padding:0, fontFamily:"Georgia,serif", display:"flex", alignItems:"center", gap:4 }}>
                    {forumMyLikes[reply.id] ? "★" : "☆"} {forumLikeCounts[reply.id] || 0}
                  </button>
                  <button onClick={() => { setForumReplyToId(reply.id); setForumReplyToName(reply.display_name); setTimeout(() => { const box = document.getElementById("forum-reply-composer"); if (box) box.scrollIntoView({ behavior:"smooth", block:"center" }); const ta = document.getElementById("forum-reply-textarea"); if (ta) ta.focus(); }, 60); }}
                    style={{ background:"transparent", border:"none", color:lightMode?"#2a0850":"#9a8060", cursor:"pointer", fontSize:10, padding:0, fontFamily:"Georgia,serif" }}>
                    ↩ Antworten
                  </button>
                </div>
              </div>
            </div>
          </>)}
        </div>
        {children.map(child => (
          <ForumReplyThread key={child.id} reply={child} allReplies={allReplies} depth={depth + 1} />
        ))}
      </div>
    );
  };

  // Diese Bereiche sind auch ohne Login erreichbar — alles andere bleibt hinter der Anmeldung.
  // "random" (Frage) ist als kleiner kostenloser Vorgeschmack gedacht; Forum-LESEN ist frei,
  // aber zum Schreiben braucht's trotzdem ein Konto (das wird innerhalb des Forums selbst geprüft).
  const freieViews = ["liesmich", "fragmich", "forum", "shop", "impressum", "agb"];
  if (!session && !freieViews.includes(view)) return loginScreen;

  // PRO-geschützte Bereiche: das sind die Inhalte, die früher exklusiv im gedruckten Buch
  // standen (Kombinationen, alle Karten, Personen-Matrix, Situations-Matrix) sowie
  // Zauberzettel und Writing. "Frage" bleibt bewusst frei als kostenloser Vorgeschmack,
  // genau wie Tageskarten, Forum und Quiz.
  const proGatedView = () => {
    if (view === "picker" || view === "cards") return true;
    if (view === "matrix" && mode === "situation") return true;
    if (view === "personen" && mode === "personen") return true;
    if (view === "tagebuch" && (dailyMode === "manifest" || dailyMode === "writing")) return true;
    return false;
  };
  // Erst sperren, wenn die Rolle wirklich geladen ist (userRole!==null).
  // Sonst blitzt das Overlay kurz auf, solange Supabase die Admin/Pro-Rolle noch lädt.
  if (session && userRole !== null && !isPro && proGatedView()) {
    return (
      <div style={{ minHeight:"100vh", background:"linear-gradient(160deg,#080512,#0f0a1a,#0a0810)", fontFamily:"Georgia,serif", color:"#f0e8d8", display:"flex", alignItems:"center", justifyContent:"center", padding:20 }}>
        <div style={{ maxWidth:440, textAlign:"center", background:"rgba(200,169,110,0.04)", border:`1px solid ${lightMode?"rgba(80,30,120,0.3)":"rgba(200,169,110,0.25)"}`, borderRadius:14, padding:"40px 32px" }}>
          <div style={{ fontSize:32, marginBottom:14 }}>🔒</div>
          <div style={{ fontSize:18, color:gold, marginBottom:12 }}>Dieser Bereich ist PRO</div>
          <div style={{ fontSize:13, color:"#9a8060", lineHeight:1.7, marginBottom:24 }}>
            Dieser Inhalt gehört zu den Kernkapiteln der Lenormand Matrix und ist daher Teil des PRO-Zugangs, genau wie im Buch.
          </div>
          <a href="https://www.annabenoir.de/product-page/lenormand-matrix-app" target="_blank" rel="noopener noreferrer"
            style={{ display:"inline-block", background:"rgba(200,169,110,0.12)", border:`1px solid ${gold}`, color:gold, padding:"10px 26px", borderRadius:6, textDecoration:"none", fontSize:13, letterSpacing:1 }}>
            Jetzt freischalten →
          </a>
          <div style={{ marginTop:18 }}>
            <button onClick={() => { setView("liesmich"); }} style={{ background:"transparent", border:"none", color:"#7a6040", cursor:"pointer", fontSize:12, fontFamily:"Georgia,serif" }}>← Zurück zur Übersicht</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={lightMode ? "light-theme" : "dark-theme"} style={{ minHeight:"100vh", background:appBg, fontFamily:"Georgia,serif", color:appColor, transition:"background 0.4s" }}>

      {(isAdmin || hasHomeAdmin) && (
        <AdminBar
          gold={gold}
          lightMode={lightMode}
          displayName={userDisplayName || getUserEmail()}
          myEmail={getUserEmail()}
          accounts={switcherAccounts}
          accountsLoading={switcherLoading}
          open={switcherOpen}
          onOpen={() => { setSwitcherOpen(true); loadSwitcherAccounts(); }}
          onClose={() => { setSwitcherOpen(false); setSwitcherAddOpen(false); setSwitcherMsg(""); }}
          onSwitch={(acc) => switchToAccount(acc, getUserId(), getAccessToken(), setSwitcherSwitching)}
          switching={switcherSwitching}
          onForget={async (id) => { await forgetAccount(id, getAccessToken()); loadSwitcherAccounts(); }}
          addOpen={switcherAddOpen}
          onAddOpen={() => setSwitcherAddOpen(true)}
          onAddCancel={() => { setSwitcherAddOpen(false); setSwitcherMsg(""); }}
          onAddSubmit={handleSwitcherAddAccount}
          addMsg={switcherMsg}
          isRealAdmin={isAdmin}
          onBackToAdmin={handleBackToAdmin}
          switchingBack={switchingBackToAdmin}
        />
      )}

      {/* Konfetti */}
      {showConfetti && (
        <div onClick={() => setShowConfetti(false)} style={{ position:"fixed", inset:0, pointerEvents:"all", zIndex:3000, overflow:"hidden", cursor:"pointer" }}>
          <ConfettiCanvas />
          <style>{`
            @keyframes recordPulse {
              0%,100% { transform: translate(-50%,-50%) scale(1); opacity:1; }
              50% { transform: translate(-50%,-50%) scale(1.08); opacity:0.9; }
            }
            .light-theme, .light-theme div, .light-theme span, .light-theme p,
            .light-theme h1, .light-theme h2, .light-theme h3, .light-theme button,
            .light-theme input, .light-theme textarea, .light-theme a, .light-theme label {
              color: #2a0850 !important;
            }
            .light-theme input, .light-theme textarea {
              background: rgba(100,50,140,0.06) !important;
            }
          `}</style>
          <div style={{
            position:"fixed",
            top:"40%", left:"50%",
            transform:"translate(-50%,-50%)",
            textAlign:"center",
            animation:"recordPulse 0.6s ease-in-out infinite",
            background:"rgba(8,5,18,0.85)",
            border:"2px solid #c8a96e",
            borderRadius:16,
            padding:"24px 40px",
            boxShadow:"0 0 40px rgba(200,169,110,0.4)"
          }}>
            <div style={{ fontSize:40, marginBottom:8 }}>🏆</div>
            <div style={{ fontSize:22, color:"#c8a96e", fontFamily:"Georgia,serif", letterSpacing:2, marginBottom:4 }}>
              NEUER REKORD!
            </div>
            <div style={{ fontSize:13, color:"#a09070", fontFamily:"Georgia,serif" }}>
              {quizMode === "kombis" ? "Kombinationen" : quizMode === "zeit" ? "Zeitrahmen" : "Personen"}
            </div>
          </div>
        </div>
      )}

      {/* Splash Screen */}
      {showSplash && (
        <div
          onClick={() => setShowSplash(false)}
          style={{
            position:"fixed", inset:0, zIndex:2000, cursor:"pointer",
            background:"#080512",
            display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center"
          }}>
          <img
            src={splashImage}
            alt="Lenormandia"
            style={{ width:"100%", height:"100%", objectFit:"contain", objectPosition:"center center", position:"absolute", inset:0 }}
          />
          <div style={{
            position:"absolute", bottom:"8%", left:0, right:0,
            textAlign:"center"
          }}>
            <div style={{
              fontSize:14, color:"#c8a96e", letterSpacing:4,
              fontFamily:"Georgia,serif",
              textShadow:"0 0 20px rgba(200,169,110,0.8)",
              padding:"12px 20px",
              background:"rgba(0,0,0,0.4)",
              display:"inline-block",
              borderRadius:20
            }}>
              ✦ Tippe um zu beginnen ✦
            </div>
          </div>
        </div>
      )}

      {access === "expired" && (
        <div style={{ position:"fixed", inset:0, background:"linear-gradient(160deg,#080512,#0f0a1a)", display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", zIndex:1000, padding:24 }}>
          <div style={{ fontSize:40, marginBottom:16 }}>🔐</div>
          <h2 style={{ color:"#c8a96e", fontWeight:"normal", fontSize:22, marginBottom:8, textAlign:"center" }}>Lenormandia</h2>
          <p style={{ color:"#7a6040", fontSize:13, marginBottom:24, textAlign:"center", maxWidth:320 }}>
            Deine 14-tägige Probezeit ist abgelaufen.<br/>Gib dein Passwort ein um weiterzumachen.
          </p>
          <input type="password" placeholder="Passwort eingeben…" value={pwInput}
            onChange={e => { setPwInput(e.target.value); setPwError(false); }}
            onKeyDown={e => e.key === "Enter" && tryPassword()}
            style={{ width:"100%", maxWidth:280, padding:"10px 16px", background:"rgba(200,169,110,0.06)", border:`1px solid ${pwError ? "#c87a6a" : "rgba(200,169,110,0.3)"}`, borderRadius:8, color:"#e8dcc8", fontFamily:"Georgia,serif", fontSize:14, outline:"none", marginBottom:8, boxSizing:"border-box", textAlign:"center" }} />
          {pwError && <div style={{ color:"#c87a6a", fontSize:11, marginBottom:8 }}>Falsches Passwort</div>}
          <button onClick={tryPassword}
            style={{ background:"rgba(200,169,110,0.12)", border:"1px solid #c8a96e", color:"#c8a96e", padding:"10px 28px", borderRadius:6, cursor:"pointer", fontSize:13, fontFamily:"Georgia,serif", marginBottom:24 }}>
            Freischalten
          </button>
          <a href="https://www.annabenoir.de" target="_blank" rel="noopener noreferrer"
            style={{ fontSize:11, color:"#5a4a34", textDecoration:"none" }}>
            Passwort kaufen → www.AnnaBenoir.de
          </a>
        </div>
      )}

      {access === "trial" && (
        <div style={{ background:"rgba(200,169,110,0.08)", borderBottom:`1px solid ${lightMode?"rgba(80,30,120,0.3)":"rgba(200,169,110,0.2)"}`, padding:"8px 16px", textAlign:"center", fontSize:11, color:lightMode?"#2a0850":"#9a8060" }}>
          ✦ Probezeit: noch {getDaysLeft()} Tage kostenlos &nbsp;·&nbsp;
          <a href="https://www.annabenoir.de/product-page/lenormand-matrix-app" target="_blank" rel="noopener noreferrer" style={{ color:lightMode?"#5a1080":"#c8a96e", textDecoration:"none" }}>
            Jetzt freischalten →
          </a>
        </div>
      )}

      {access !== "trial" && proTrialDaysLeft !== null && (
        <div style={{ background:"rgba(200,169,110,0.08)", borderBottom:`1px solid ${lightMode?"rgba(80,30,120,0.3)":"rgba(200,169,110,0.2)"}`, padding:"8px 16px", textAlign:"center", fontSize:11, color:lightMode?"#2a0850":"#9a8060" }}>
          ✦ Pro-Testphase: noch {proTrialDaysLeft} {proTrialDaysLeft === 1 ? "Tag" : "Tage"} kostenlos &nbsp;·&nbsp;
          <a href="https://www.annabenoir.de/product-page/lenormand-matrix-app" target="_blank" rel="noopener noreferrer" style={{ color:lightMode?"#5a1080":"#c8a96e", textDecoration:"none" }}>
            Jetzt freischalten →
          </a>
        </div>
      )}

      <div style={{ position:"fixed", inset:0, pointerEvents:"none", background:"radial-gradient(ellipse at 15% 15%,rgba(180,120,60,0.07) 0%,transparent 45%),radial-gradient(ellipse at 85% 85%,rgba(60,40,100,0.08) 0%,transparent 45%)" }}/>

      {/* Header */}
      <div style={{ textAlign:"center", padding:"24px 20px 14px", borderBottom:`1px solid ${lightMode?"rgba(80,30,120,0.3)":"rgba(200,169,110,0.15)"}`, position:"relative" }}>
        <button onClick={toggleTheme} style={{ position:"absolute", top:16, right:16, background:"transparent", border:`1px solid ${lightMode?"rgba(100,40,120,0.3)":"rgba(200,169,110,0.2)"}`, color:lightMode?"#6a2a8a":"#7a6040", padding:"4px 12px", borderRadius:20, cursor:"pointer", fontSize:11, fontFamily:"Georgia,serif", display:"none" }}>
          {lightMode ? "🌙 Dunkel" : "☀️ Hell"}
        </button>
        <div style={{ fontSize:10, letterSpacing:6, color: lightMode?"#8a5a9a":"#7a6040", marginBottom:5, textTransform:"uppercase" }}>Anna Benoir</div>
        <h1 style={{ fontSize:"clamp(26px,4vw,42px)", fontWeight:"normal", color: lightMode?"#5a1080":gold, margin:"0 0 4px", letterSpacing:2 }}>Lenormandia</h1>
        <div style={{ fontSize:10, color: lightMode?"#7a3a9a":"#6a5040", letterSpacing:2, marginBottom:8, fontStyle:"italic" }}>wo Karten Geheimnisse offenbaren — und du nicht allein damit bist</div>
        <div style={{ display:"flex", justifyContent:"center", gap:8, marginTop:12 }}>
          {/* Reihe 1 */}
          {[["liesmich","📖 Willkommen"],["random","🔮 Frage"],["personen","👤 Person"],["matrix","⬛ Matrix"]].map(([v,l]) => {
            const active = v==="random" ? view==="fragmich" : view===v;
            return (
            <button key={v} onClick={() => {
                if(v==="random") { startRandom(); }
                else if(v==="personen") { setView("personen"); setMatrixView("question"); setMode("personen"); setSignifikator(null); setMatrixCards(Array(9).fill(null)); setActivePos(null); setQuestion(""); setRandomMode(false); }
                else if(v==="matrix") { setView("matrix"); setMatrixView("question"); setMode("situation"); setSignifikator(null); setMatrixCards(Array(9).fill(null)); setActivePos(null); setQuestion(""); setRandomMode(false); }
                else { setView(v); setDailyMode("tagebuch"); setTagebuchView("tagebuch"); setKlientName(""); setKlientGeburt(""); setTippVisible(false); if(v!==view) reset(); }
              }}
              style={{ background:active?(lightMode?"rgba(200,168,224,0.18)":"rgba(200,169,110,0.12)"):"transparent", border:`1px solid ${active?(lightMode?"#c8a8e0":"rgba(200,169,110,0.4)"):"rgba(200,169,110,0.12)"}`, color:active?gold:"#5a4a34", padding:"7px 16px", borderRadius:4, cursor:"pointer", fontSize:13, letterSpacing:1, fontFamily:"Georgia,serif" }}>
              {l}
            </button>
          ); })}
        </div>
        <div style={{ display:"flex", justifyContent:"center", gap:8, marginTop:6 }}>
          {[["picker","🃏 Kombis"],["cards","📖 Alle Karten"],["tagebuch","✨ Daily"],["forum","📰 News"],["shop","🛍️ Shop"]].map(([v,l]) => (
            <button key={v} onClick={() => {
                if(v==="random") { startRandom(); }
                else if(v==="personen") { setView("personen"); setMatrixView("question"); setMode("personen"); setSignifikator(null); setMatrixCards(Array(9).fill(null)); setActivePos(null); setQuestion(""); setRandomMode(false); }
                else if(v==="tagebuch") { setView(v); setDailyMode("tagebuch"); setTagebuchView("tagebuch"); setKlientName(""); setKlientGeburt(""); setTippVisible(false); if(v!==view) reset(); }
                else if(v==="forum") { setView(v); setCommunityMode("forum"); setForumView("liste"); setForumActiveCategory(null); setForumActivePost(null); }
                else { if(v==="matrix") { setView("matrix"); setMatrixView("question"); setMode("situation"); setSignifikator(null); setMatrixCards(Array(9).fill(null)); setActivePos(null); setQuestion(""); } else { setView(v); if(v!==view) reset(); } }
              }}
              style={{ background:view===v?(lightMode?"rgba(200,168,224,0.18)":"rgba(200,169,110,0.12)"):"transparent", border:`1px solid ${view===v?(lightMode?"#c8a8e0":"rgba(200,169,110,0.4)"):"rgba(200,169,110,0.12)"}`, color:view===v?gold:"#5a4a34", padding:"7px 16px", borderRadius:4, cursor:"pointer", fontSize:13, letterSpacing:1, fontFamily:"Georgia,serif" }}>
              {l}
            </button>
          ))}
        </div>
      </div>

      {/* Banner — nur für Gäste, Mitglieder und Test-Pro */}
      {!isProFull && !isAdmin && !isMod && (
      <div style={{ maxWidth:"100%", margin:"0 auto", padding:"10px 24px 0" }}>
        <a href="https://www.amazon.de/s?k=lenormand+karten+bedeutung+lernen+anna+benoir" target="_blank" rel="noopener noreferrer" style={{ display:"block", textDecoration:"none" }}>
          <div style={{ width:"100%", height:90, borderRadius:8, overflow:"hidden", border:`1px solid ${lightMode?"rgba(100,50,140,0.2)":"rgba(200,169,110,0.15)"}`, background: lightMode?"linear-gradient(to right, #e8d8f8, #d0b8e8, #c8a8e0)":"linear-gradient(to right, #1a0a2a, #2a1040, #1a0a2a)", display:"flex", alignItems:"center", justifyContent:"space-between", padding:"0 24px", gap:16 }}>
            <div style={{ fontSize:22 }}>📚🐍✨</div>
            <div style={{ flex:1, textAlign:"center" }}>
              <div style={{ fontSize:13, color:lightMode?"#3a1060":"#c8a96e", fontFamily:"Georgia,serif", letterSpacing:1, marginBottom:3 }}>Lenormand Karten Bedeutung Lernen</div>
              <div style={{ fontSize:10, color:lightMode?"#6a3a8a":"#9a8060", letterSpacing:2, textTransform:"uppercase" }}>Ausmalen & Lernen · Jetzt bei Amazon</div>
            </div>
            <div style={{ fontSize:11, color:lightMode?"#3a1060":"#c8a96e", fontFamily:"Georgia,serif", whiteSpace:"nowrap" }}>→ Amazon</div>
          </div>
        </a>
      </div>
      )}

      <div style={{ maxWidth:"100%", margin:"0 auto", padding:"24px 24px 60px" }}>
        <div className={writingFullWidth ? "lenapp-grid lenapp-grid-full" : "lenapp-grid"}>
          <style>{`.lenapp-grid{display:grid;grid-template-columns:clamp(220px,20vw,320px) minmax(0,1fr) clamp(220px,20vw,320px);gap:14px;align-items:start}.lenapp-grid-full{grid-template-columns:1fr}.lenapp-side-left{position:sticky;top:12px}.lenapp-side-right{position:sticky;top:12px}@media(max-width:900px){.lenapp-grid{grid-template-columns:1fr}.lenapp-side-right{display:none}.lenapp-side-left{position:static}}`}</style>
          {!writingFullWidth && <aside className="lenapp-side-left">{renderLeftRail()}</aside>}
          <main style={{ minWidth:0 }}>

        {/* ── KOMBINATIONEN ── */}
        {/* ── LIESMICH ── */}
        {view === "liesmich" && (
          <div style={{ maxWidth:"100%", margin:"0 auto" }}>
            <div style={{ borderRadius:12, overflow:"hidden", marginBottom:24, position:"relative", paddingTop:"56.25%" }}>
              <iframe
                src="https://www.youtube.com/embed/N9sWhC_j_qE"
                title="Anna Benoir - Lenormandia"
                style={{ position:"absolute", top:0, left:0, width:"100%", height:"100%", border:"none" }}
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                allowFullScreen
              />
            </div>
            <div style={{ background:lightMode?"rgba(200,168,224,0.12)":"rgba(200,169,110,0.03)", border:`1px solid ${lightMode?"#c8a8e0":"rgba(200,169,110,0.18)"}`, borderRadius:12, padding:"28px 32px", marginBottom:24 }}>
              <div style={{ fontSize:9, letterSpacing:4, color:lightMode?"#2a0850":"#7a6040", textTransform:"uppercase", marginBottom:16 }}>Einleitung</div>
              {("Willkommen in der Welt der Mlle Lenormand.\n\nPassend zum 10-jährigen Jubiläum der Lenormand Matrix gehen wir mit der Zeit — und verwandeln das Buch in ein Erlebnis.\n\nDas Lenormand ist eine sehr alte, ehrliche und vor allem alltagstaugliche Sprache der Symbole. Sie spricht nicht immer das aus, was wir hören wollen. Aber sie sagt immer das, was wir brauchen.\n\nWas mich an den Lenormand-Karten am meisten gewurmt hat, war dass sie auf der einen Seite so viele Informationen zu bieten haben — man aber die Hälfte mindestens übersieht, wenn man sie nicht alle auswendig kann. Ich wollte mich nicht geschlagen geben. Nicht von diesen Karten!\n\nAlso habe ich mich durch die Massen an Informationen gewühlt, sortiert — und sie in einer Matrix zusammengeschrieben, damit du mit ihr sicher, sanft und sehr, sehr schnell arbeiten kannst.\n\nIn dieser App findest du alle 1260 Kombinationen, die Situations-Matrix und die Personen-Matrix — und ein Quiz, damit du die Karten wirklich lernst. Nicht auswendig. Sondern mit dem Herzen.\n\nIn einem magischen Universum wird nichts dem Zufall überlassen. Auch nicht, dass du hier gelandet bist.\n\nMein Name ist Anna Benoir — und ich lege die Karten. 🎴").split("\n\n").map((para, i) => (
                <p key={i} style={{ fontSize:15, lineHeight:1.9, color:lightMode?"#2a0850":"#d4c4a0", marginBottom:16, fontFamily:"Georgia,serif" }}>
                  {para}
                </p>
              ))}
            </div>
          </div>
        )}

        {view === "picker" && (<>
          {/* Umschalter 2er | 3er | 4er */}
          <div style={{ display:"flex", justifyContent:"center", gap:8, marginBottom:18 }}>
            {[["2er","🃏"],["3er","🔺"],["4er","🔷"]].map(([m,icon]) => (
              <button key={m} onClick={() => { setComboView(m); setComboSelected([]); setSelected([]); setSearch(""); }}
                style={{ background:comboView===m?(lightMode?"rgba(200,168,224,0.18)":"rgba(200,169,110,0.15)"):"rgba(200,169,110,0.03)", border:`1px solid ${comboView===m?(lightMode?"#c8a8e0":gold):"rgba(200,169,110,0.2)"}`, color:comboView===m?gold:"#7a6040", padding:"7px 20px", borderRadius:8, cursor:"pointer", fontSize:12, fontFamily:"Georgia,serif", letterSpacing:1, transition:"all 0.2s" }}>
                {icon} {m}
              </button>
            ))}
          </div>

          {/* ── 2er Picker (original) ── */}
          {comboView === "2er" && (<>
            <div style={{ display:"flex", gap:12, justifyContent:"center", alignItems:"center", marginBottom:18, minHeight:80 }}>
              {[0,1].map(i => (
                <div key={i} style={{ width:92, height:126, border:`1.5px solid ${selected[i]?gold:"rgba(200,169,110,0.12)"}`, borderRadius:8, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", background:selected[i]?"rgba(200,169,110,0.04)":lightMode?"rgba(100,50,140,0.06)":"rgba(10,7,18,0.4)", transition:"all 0.3s", position:"relative" }}>
                  {selected[i] ? (<>
                    <div style={{ fontSize:26 }}>{SYMBOLS[selected[i]]}</div>
                    <div style={{ fontSize:9, color:gold, textAlign:"center", padding:"3px 4px", lineHeight:1.3 }}>{selected[i]}. {CARDS[selected[i]].name}</div>
                    <button onClick={() => setSelected(prev => prev.filter((_,j)=>j!==i))}
                      style={{ position:"absolute", top:3, right:3, background:"rgba(200,169,110,0.08)", border:"none", color:gold, cursor:"pointer", borderRadius:"50%", width:15, height:15, fontSize:8, lineHeight:"15px", padding:0 }}>✕</button>
                  </>) : <div style={{ color:"#2a1a0a", fontSize:9 }}>Karte {i+1}</div>}
                </div>
              ))}
            </div>
            {selected.length === 2 && showResult && (
              <div style={{ background:"rgba(200,169,110,0.03)", border:"1px solid rgba(200,169,110,0.18)", borderRadius:10, padding:"18px 22px", marginBottom:20 }}>
                <div style={{ fontSize:9, letterSpacing:4, color:lightMode?"#2a0850":"#7a6040", marginBottom:10, textTransform:"uppercase" }}>
                  {mode==="situation"?"Situations-Deutung":"Personen-Deutung"} · {CARDS[selected[0]].name} + {CARDS[selected[1]].name}
                </div>
                <div style={{ fontSize:17, lineHeight:1.95, color:lightMode?"#2a0850":"#e0d0b0", borderLeft:"2px solid rgba(200,169,110,0.25)", paddingLeft:14 }}>{showResult}</div>
                <div style={{ marginTop:14, paddingTop:12, borderTop:`1px solid ${lightMode?"rgba(80,30,120,0.3)":"rgba(200,169,110,0.08)"}` }}>
                  <div style={{ fontSize:9, letterSpacing:3, color:"#5a4a30", marginBottom:6, textTransform:"uppercase" }}>Keywords</div>
                  <div style={{ fontSize:11, color:"#8a7860", lineHeight:1.6 }}><span style={{color:gold}}>{CARDS[selected[0]].name}:</span> {CARDS[selected[0]].kw}</div>
                  <div style={{ fontSize:11, color:"#8a7860", lineHeight:1.6, marginTop:3 }}><span style={{color:gold}}>{CARDS[selected[1]].name}:</span> {CARDS[selected[1]].kw}</div>
                </div>
                <button onClick={() => setSelected([])} style={{ marginTop:12, background:"transparent", border:`1px solid ${lightMode?"rgba(80,30,120,0.3)":"rgba(200,169,110,0.15)"}`, color:lightMode?"#2a0850":"#5a4a34", padding:"4px 12px", borderRadius:4, cursor:"pointer", fontSize:10, fontFamily:"Georgia,serif" }}>↩ Neu</button>
              </div>
            )}
            <div style={{ marginBottom:12 }}>
              <input placeholder="Karte suchen…" value={search} onChange={e => setSearch(e.target.value)}
                style={{ width:"100%", padding:"6px 12px", background:"rgba(200,169,110,0.03)", border:`1px solid ${lightMode?"rgba(80,30,120,0.3)":"rgba(200,169,110,0.15)"}`, borderRadius:5, color:gold, fontFamily:"Georgia,serif", fontSize:11, outline:"none", boxSizing:"border-box" }} />
            </div>
            <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(110px,1fr))", gap:8 }}>
              {filteredCards().map(num => {
                const isSel = selected.includes(num);
                const isDisabled = selected.length === 2 && !isSel;
                return (
                  <button key={num} onClick={() => !isDisabled && toggleCard(num)}
                    style={{ background:isSel?"rgba(200,169,110,0.15)":"rgba(200,169,110,0.015)", border:`1px solid ${isSel?gold:(lightMode?"rgba(80,30,120,0.3)":"rgba(200,169,110,0.1)")}`, borderRadius:7, padding:"8px 4px", cursor:isDisabled?"default":"pointer", opacity:isDisabled?0.22:1, color:isSel?gold:(lightMode?"#2a0850":"#d4c4a0"), transition:"all 0.18s", textAlign:"center", fontFamily:"Georgia,serif" }}
                    onMouseEnter={e => { if(isDisabled)return; e.currentTarget.style.borderColor=lightMode?"#c8a8e0":"rgba(200,169,110,0.35)"; e.currentTarget.style.color=gold; }}
                    onMouseLeave={e => { e.currentTarget.style.borderColor=isSel?gold:(lightMode?"rgba(80,30,120,0.3)":"rgba(200,169,110,0.1)"); e.currentTarget.style.color=isSel?gold:(lightMode?"#2a0850":"#d4c4a0"); }}>
                    <div style={{ fontSize:26 }}>{SYMBOLS[num]}</div>
                    <div style={{ fontSize:12, marginTop:5, lineHeight:1.3 }}>{num}. {CARDS[num].name}</div>
                  </button>
                );
              })}
            </div>
            {selected.length === 1 && <div style={{ textAlign:"center", marginTop:14, color:lightMode?"#2a0850":"#5a4a34", fontSize:11, fontStyle:"italic" }}>Wähle noch eine zweite Karte…</div>}
          </>)}

          {/* ── 3er / 4er Picker ── */}
          {(comboView === "3er" || comboView === "4er") && (() => {
            const maxCards = comboView === "3er" ? 3 : 4;
            const needed = maxCards - comboSelected.length;
            const cluster = CLUSTERS[comboView].find(c =>
              comboSelected.length === maxCards &&
              c.karten.every(k => comboSelected.includes(k)) &&
              comboSelected.every(k => c.karten.includes(k))
            );
            const fallback2er = comboSelected.length >= 2 ? (() => {
              const [a,b] = comboSelected;
              const lo = Math.min(a,b), hi = Math.max(a,b);
              return COMBOS[`${lo}-${hi}`] || null;
            })() : null;
            return (<>
              {/* Kartenslots */}
              <div style={{ display:"flex", gap:8, justifyContent:"center", alignItems:"center", marginBottom:18, flexWrap:"wrap" }}>
                {Array.from({length:maxCards}).map((_,i) => {
                  const num = comboSelected[i];
                  return (
                    <div key={i} style={{ width:80, height:112, border:`1.5px solid ${num?gold:"rgba(200,169,110,0.12)"}`, borderRadius:8, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", background:num?"rgba(200,169,110,0.04)":lightMode?"rgba(100,50,140,0.06)":"rgba(10,7,18,0.4)", transition:"all 0.3s", position:"relative" }}>
                      {num ? (<>
                        <div style={{ fontSize:22 }}>{SYMBOLS[num]}</div>
                        <div style={{ fontSize:8, color:gold, textAlign:"center", padding:"2px 3px", lineHeight:1.3 }}>{num}. {CARDS[num].name}</div>
                        <button onClick={() => setComboSelected(prev => prev.filter(k => k !== num))}
                          style={{ position:"absolute", top:2, right:2, background:"rgba(200,169,110,0.08)", border:"none", color:gold, cursor:"pointer", borderRadius:"50%", width:14, height:14, fontSize:8, lineHeight:"14px", padding:0 }}>✕</button>
                      </>) : <div style={{ color:"#3a2a0a", fontSize:8 }}>Karte {i+1}</div>}
                    </div>
                  );
                })}
              </div>

              {/* Ergebnis wenn alle Karten gewählt */}
              {comboSelected.length === maxCards && (
                <div style={{ marginBottom:16 }}>
                  {cluster ? (
                    <div style={{ background:"rgba(200,169,110,0.03)", border:`1px solid ${lightMode?"rgba(80,30,120,0.3)":"rgba(200,169,110,0.25)"}`, borderRadius:10, padding:"16px 20px" }}>
                      <div style={{ fontSize:9, letterSpacing:3, color:lightMode?"#2a0850":"#7a6040", textTransform:"uppercase", marginBottom:8 }}>{comboView} · Erweiterte Bedeutung</div>
                      <div style={{ display:"inline-block", background:"rgba(200,169,110,0.12)", border:`1px solid ${lightMode?"rgba(80,30,120,0.3)":"rgba(200,169,110,0.3)"}`, borderRadius:4, padding:"2px 8px", fontSize:9, color:gold, marginBottom:10, letterSpacing:0.5 }}>{cluster.label}</div>
                      <div style={{ fontSize:16, lineHeight:1.9, color:lightMode?"#2a0850":"#e0d0b0", borderLeft:"2px solid rgba(200,169,110,0.3)", paddingLeft:14 }}>{cluster.text}</div>
                    </div>
                  ) : (
                    <div style={{ background:"rgba(200,169,110,0.02)", border:`1px solid ${lightMode?"rgba(80,30,120,0.3)":"rgba(200,169,110,0.15)"}`, borderRadius:10, padding:"14px 18px" }}>
                      <div style={{ fontSize:12, color:lightMode?"#2a0850":"#9a8060", fontStyle:"italic", marginBottom:12, lineHeight:1.6 }}>
                        ✦ Diese Konstellation hat keine eigene Bedeutungsebene — doch die Karten sprechen trotzdem. Die ersten zwei Karten erzählen:
                      </div>
                      {fallback2er ? (
                        <div style={{ fontSize:15, lineHeight:1.9, color:lightMode?"#2a0850":"#d4c4a0", borderLeft:"2px solid rgba(200,169,110,0.2)", paddingLeft:14 }}>{fallback2er}</div>
                      ) : (
                        <div style={{ fontSize:13, color:lightMode?"#2a0850":"#5a4a34", fontStyle:"italic" }}>Keine 2er-Kombination gefunden.</div>
                      )}
                    </div>
                  )}
                  <button onClick={() => setComboSelected([])} style={{ marginTop:10, background:"transparent", border:`1px solid ${lightMode?"rgba(80,30,120,0.3)":"rgba(200,169,110,0.15)"}`, color:lightMode?"#2a0850":"#5a4a34", padding:"4px 12px", borderRadius:4, cursor:"pointer", fontSize:10, fontFamily:"Georgia,serif" }}>↩ Neu</button>
                </div>
              )}

              {/* Hinweis wie viele noch fehlen */}
              {comboSelected.length < maxCards && comboSelected.length > 0 && (
                <div style={{ textAlign:"center", marginBottom:10, color:lightMode?"#2a0850":"#5a4a34", fontSize:11, fontStyle:"italic" }}>
                  Noch {needed} Karte{needed>1?"n":""} wählen…
                </div>
              )}

              {/* Kartengitter */}
              {comboSelected.length < maxCards && (<>
                <div style={{ marginBottom:12 }}>
                  <input placeholder="Karte suchen…" value={search} onChange={e => setSearch(e.target.value)}
                    style={{ width:"100%", padding:"6px 12px", background:"rgba(200,169,110,0.03)", border:`1px solid ${lightMode?"rgba(80,30,120,0.3)":"rgba(200,169,110,0.15)"}`, borderRadius:5, color:gold, fontFamily:"Georgia,serif", fontSize:11, outline:"none", boxSizing:"border-box" }} />
                </div>
                <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(110px,1fr))", gap:8 }}>
                  {filteredCards().map(num => {
                    const isSel = comboSelected.includes(num);
                    return (
                      <button key={num} onClick={() => {
                        if (isSel) setComboSelected(prev => prev.filter(k => k !== num));
                        else if (comboSelected.length < maxCards) setComboSelected(prev => [...prev, num]);
                      }}
                        style={{ background:isSel?"rgba(200,169,110,0.15)":"rgba(200,169,110,0.015)", border:`1px solid ${isSel?gold:(lightMode?"rgba(80,30,120,0.3)":"rgba(200,169,110,0.1)")}`, borderRadius:7, padding:"8px 4px", cursor:"pointer", color:isSel?gold:(lightMode?"#2a0850":"#d4c4a0"), transition:"all 0.18s", textAlign:"center", fontFamily:"Georgia,serif" }}
                        onMouseEnter={e => { e.currentTarget.style.borderColor=lightMode?"#c8a8e0":"rgba(200,169,110,0.35)"; e.currentTarget.style.color=gold; }}
                        onMouseLeave={e => { e.currentTarget.style.borderColor=isSel?gold:(lightMode?"rgba(80,30,120,0.3)":"rgba(200,169,110,0.1)"); e.currentTarget.style.color=isSel?gold:(lightMode?"#2a0850":"#d4c4a0"); }}>
                        <div style={{ fontSize:26 }}>{SYMBOLS[num]}</div>
                        <div style={{ fontSize:12, marginTop:5, lineHeight:1.3 }}>{num}. {CARDS[num].name}</div>
                      </button>
                    );
                  })}
                </div>
              </>)}
            </>);
          })()}
        </>)}

        {/* ── MATRIX ── */}
        {(view === "matrix" || view === "personen" || view === "fragmich") && (<>
          {/* Step 0: Frage eingeben */}
          {matrixView === "question" && (<>
            <div style={{ textAlign:"center", marginBottom:20 }}>
              <div style={{ fontSize:10, letterSpacing:4, color:lightMode?"#2a0850":"#7a6040", textTransform:"uppercase", marginBottom:6 }}>Schritt 1</div>
              <div style={{ fontSize:16, color:gold, marginBottom:6 }}>Deine Frage</div>
              <div style={{ fontSize:11, color:lightMode?"#2a0850":"#5a4a34" }}>Formuliere deine Frage so klar wie möglich</div>
            </div>
            <textarea
              placeholder="Was möchtest du wissen?"
              value={question}
              onChange={e => setQuestion(e.target.value)}
              rows={3}
              style={{ width:"100%", padding:"12px 14px", background:"rgba(200,169,110,0.04)", border:`1px solid ${lightMode?"rgba(80,30,120,0.3)":"rgba(200,169,110,0.25)"}`, borderRadius:8, color:lightMode?"#2a0850":"#d4c4a0", fontFamily:"Georgia,serif", fontSize:14, outline:"none", boxSizing:"border-box", resize:"none", lineHeight:1.6 }}
            />
            <div style={{ display:"flex", justifyContent:"center", gap:10, marginTop:16, flexWrap:"wrap" }}>
              {mode === "personen" && (
                <button onClick={() => { fullRandom(); }}
                  style={{ background:lightMode?"rgba(200,168,224,0.18)":"rgba(200,169,110,0.08)", border:`1px solid ${lightMode?"#c8a8e0":"rgba(200,169,110,0.35)"}`, color:gold, padding:"10px 22px", borderRadius:6, cursor:"pointer", fontSize:13, fontFamily:"Georgia,serif", letterSpacing:1 }}>
                  🎲 Zufällig mischen
                </button>
              )}
              <button onClick={() => { if(randomMode) { fullRandom(); } else { setMatrixView("signifikator"); } }}
                style={{ background:lightMode?"rgba(200,168,224,0.18)":"rgba(200,169,110,0.12)", border:`1px solid ${lightMode?"#c8a8e0":gold}`, color:gold, padding:"10px 28px", borderRadius:6, cursor:"pointer", fontSize:13, fontFamily:"Georgia,serif", letterSpacing:1 }}>
                {randomMode ? "🎲 Mischen & Deuten" : mode === "personen" ? "Signifikator wählen →" : "Weiter →"}
              </button>
            </div>
          </>)}

          {/* Step 1: Signifikator wählen */}
          {matrixView === "signifikator" && (<>
            <div style={{ textAlign:"center", marginBottom:18 }}>
              <div style={{ fontSize:10, letterSpacing:4, color:lightMode?"#2a0850":"#7a6040", textTransform:"uppercase", marginBottom:6 }}>Schritt 1</div>
              <div style={{ fontSize:16, color:gold }}>Wähle deinen Signifikator</div>
              <div style={{ fontSize:11, color:lightMode?"#2a0850":"#5a4a34", marginTop:4 }}>Das Thema, um das es geht</div>
            </div>
            <div style={{ marginBottom:12 }}>
              <input placeholder="Karte suchen…" value={search} onChange={e => setSearch(e.target.value)}
                style={{ width:"100%", padding:"6px 12px", background:"rgba(200,169,110,0.03)", border:`1px solid ${lightMode?"rgba(80,30,120,0.3)":"rgba(200,169,110,0.15)"}`, borderRadius:5, color:gold, fontFamily:"Georgia,serif", fontSize:11, outline:"none", boxSizing:"border-box" }} />
            </div>
            <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(110px,1fr))", gap:8 }}>
              {filteredCards().map(num => (
                <button key={num} onClick={() => { selectSignifikator(num); setSearch(""); }}
                  style={{ background:"rgba(200,169,110,0.015)", border:`1px solid ${lightMode?"rgba(80,30,120,0.3)":"rgba(200,169,110,0.1)"}`, borderRadius:7, padding:"8px 4px", cursor:"pointer", color:lightMode?"#2a0850":"#d4c4a0", textAlign:"center", fontFamily:"Georgia,serif", transition:"all 0.18s" }}
                  onMouseEnter={e => { e.currentTarget.style.borderColor=lightMode?"#c8a8e0":"rgba(200,169,110,0.35)"; e.currentTarget.style.color=gold; }}
                  onMouseLeave={e => { e.currentTarget.style.borderColor=lightMode?"rgba(80,30,120,0.3)":"rgba(200,169,110,0.1)"; e.currentTarget.style.color=lightMode?"#2a0850":"#d4c4a0"; }}>
                  <div style={{ fontSize:26 }}>{SYMBOLS[num]}</div>
                  <div style={{ fontSize:12, marginTop:5, lineHeight:1.3 }}>{num}. {CARDS[num].name}</div>
                </button>
              ))}
            </div>
          </>)}

          {/* Step 2: Matrix Layout */}
          {matrixView === "layout" && signifikator && (<>
            {question ? (
              <div style={{ background:"rgba(200,169,110,0.03)", border:`1px solid ${lightMode?"rgba(80,30,120,0.3)":"rgba(200,169,110,0.12)"}`, borderRadius:8, padding:"10px 14px", marginBottom:14, fontSize:12, color:lightMode?"#2a0850":"#9a8060", fontStyle:"italic", lineHeight:1.5 }}>
                ✦ {question}
              </div>
            ) : null}
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:14 }}>
              <button onClick={() => setMatrixView("signifikator")} style={{ background:"transparent", border:"none", color:lightMode?"#2a0850":"#7a6040", cursor:"pointer", fontSize:11, fontFamily:"Georgia,serif" }}>← Signifikator</button>
              <div style={{ textAlign:"center" }}>
                <div style={{ fontSize:10, letterSpacing:4, color:lightMode?"#2a0850":"#7a6040", textTransform:"uppercase" }}>Schritt 2</div>
                <div style={{ fontSize:13, color:gold }}>Karten legen</div>
              </div>
<div style={{display:"flex", gap:6}}>
                <button onClick={() => setMatrixView("result")}
                  style={{ background:lightMode?"rgba(200,168,224,0.18)":"rgba(200,169,110,0.12)", border:`1px solid ${lightMode?"#c8a8e0":gold}`, color:gold, padding:"5px 12px", borderRadius:5, cursor:"pointer", fontSize:11, fontFamily:"Georgia,serif" }}>
                  Deuten →
                </button>
              </div>
            </div>

            {/* 3x3 Grid */}
            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:6, marginBottom:16 }}>
              {Array.from({length:9}, (_,pos) => {
                const card = matrixCards[pos];
                const isSignifikator = pos === 4;
                const isKombi = mode !== "personen" && KOMBI_POSITIONS.includes(pos);
                const isActive = activePos === pos;
                return (
                  <div key={pos}
                    onClick={() => {
                      if (isSignifikator) return;
                      if (card && !isActive) {
                        const newCards = [...matrixCards];
                        newCards[pos] = null;
                        setMatrixCards(newCards);
                        setActivePos(null);
                      } else {
                        setActivePos(isActive ? null : pos);
                      }
                    }}
                    style={{
                      background: isSignifikator ? "rgba(200,169,110,0.08)" : isActive ? "rgba(200,169,110,0.06)" : "rgba(200,169,110,0.015)",
                      border: `1.5px solid ${isSignifikator ? gold : isActive ? "rgba(200,169,110,0.5)" : card ? "rgba(200,169,110,0.25)" : "rgba(200,169,110,0.1)"}`,
                      borderRadius:8, padding:"10px 6px", cursor:isSignifikator?"default":"pointer",
                      textAlign:"center", minHeight:80, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center",
                      transition:"all 0.2s"
                    }}>
                    <div style={{ fontSize:8, letterSpacing:2, color:lightMode?"#2a0850":"#5a4a34", textTransform:"uppercase", marginBottom:4 }}>
                      {mode === "personen" ? ["Sternzeichen","Haarfarbe","Charakter","Figur","Signifikator","Beruf/Berufung","Größe","Alter","Woher"][pos] : (POSITION_LABELS[pos] + (isKombi ? " ✦" : ""))}
                    </div>
                    {card ? (<>
                      <div style={{ fontSize:20 }}>{SYMBOLS[card]}</div>
                      <div style={{ fontSize:8, color:gold, marginTop:2 }}>{card}. {CARDS[card].name}</div>
                      <div style={{ fontSize:7, color:"rgba(200,169,110,0.25)", marginTop:3 }}>✕ abwählen</div>
                    </>) : (
                      <div style={{ fontSize:9, color:isActive ? gold : "#3a2a18", marginTop:2 }}>
                        {isActive ? "Karte wählen ↓" : isSignifikator ? "—" : "tippen"}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Card picker for active position */}
            {activePos !== null && (<>
              <div style={{ fontSize:9, letterSpacing:3, color:lightMode?"#2a0850":"#7a6040", marginBottom:8, textTransform:"uppercase" }}>
                Karte für {POSITION_LABELS[activePos]} wählen
              </div>
              <div style={{ marginBottom:10 }}>
                <input placeholder="Suchen…" value={search} onChange={e => setSearch(e.target.value)}
                  style={{ width:"100%", padding:"5px 10px", background:"rgba(200,169,110,0.03)", border:`1px solid ${lightMode?"rgba(80,30,120,0.3)":"rgba(200,169,110,0.15)"}`, borderRadius:4, color:gold, fontFamily:"Georgia,serif", fontSize:10, outline:"none", boxSizing:"border-box" }} />
              </div>
              <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(70px,1fr))", gap:5, maxHeight:220, overflowY:"auto", padding:"4px 0" }}>
                {filteredCards(usedCards).map(num => (
                  <button key={num} onClick={() => { placeCard(num); setSearch(""); }}
                    style={{ background:"rgba(200,169,110,0.015)", border:`1px solid ${lightMode?"rgba(80,30,120,0.3)":"rgba(200,169,110,0.1)"}`, borderRadius:6, padding:"6px 3px", cursor:"pointer", color:"#7a6a54", textAlign:"center", fontFamily:"Georgia,serif" }}
                    onMouseEnter={e => { e.currentTarget.style.borderColor=lightMode?"#c8a8e0":"rgba(200,169,110,0.4)"; e.currentTarget.style.color=gold; }}
                    onMouseLeave={e => { e.currentTarget.style.borderColor=lightMode?"rgba(80,30,120,0.3)":"rgba(200,169,110,0.1)"; e.currentTarget.style.color="#7a6a54"; }}>
                    <div style={{ fontSize:16 }}>{SYMBOLS[num]}</div>
                    <div style={{ fontSize:7, marginTop:2 }}>{num}. {CARDS[num].name}</div>
                  </button>
                ))}
              </div>
            </>)}
          </>)}

          {/* Step 3: Result */}
          {matrixView === "result" && signifikator && (<>
            {question ? (
              <div style={{ background:"rgba(200,169,110,0.03)", border:`1px solid ${lightMode?"rgba(80,30,120,0.3)":"rgba(200,169,110,0.12)"}`, borderRadius:8, padding:"10px 14px", marginBottom:14, fontSize:12, color:lightMode?"#2a0850":"#9a8060", fontStyle:"italic", lineHeight:1.5 }}>
                ✦ {question}
              </div>
            ) : null}
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:16 }}>
              <button onClick={() => setMatrixView("layout")} style={{ background:"transparent", border:"none", color:lightMode?"#2a0850":"#7a6040", cursor:"pointer", fontSize:11, fontFamily:"Georgia,serif" }}>← Legung</button>
              <div style={{ textAlign:"center" }}>
                <div style={{ fontSize:13, color:gold }}>{SYMBOLS[signifikator]} {CARDS[signifikator].name}</div>
                <div style={{ fontSize:9, color:lightMode?"#2a0850":"#5a4a34" }}>{mode === "personen" ? "Personen-Matrix" : "Situations-Matrix"}</div>
              </div>
              <div style={{display:"flex", gap:8}}>
                <button onClick={() => {
                  const sig = signifikator;
                  const cardName = CARDS[sig].name;
                  const sigSymbol = SYMBOLS[sig];
                  const isPersonen = mode === "personen";
                  const posLabels = isPersonen
                    ? ["Sternzeichen","Haarfarbe","Charakter","Figur","Signifikator","Beruf/Berufung","Größe","Alter","Woher"]
                    : ["Gedanken","Ist-Situation","Rat der Engel","Warnung","Signifikator","Nahe Zukunft","Wo es herkommt","Unbewusste Zukunft","Ergebnis und wann"];
                  const sitKeys = ["gendanken",null,"rat_der_engel","warnung",null,null,"wo_es_herkommt",null,"ergebnis_und_wann"];
                  const perKeys = ["sternzeichen","haarfarbe","charakter","figur",null,"beruf","groesse","alter","woher"];
                  const activeKeys = isPersonen ? perKeys : sitKeys;
                  const kombiPos = isPersonen ? [] : [1,5,7];

                  const cells = Array.from({length:9},(_,pos) => {
                    const card = matrixCards[pos];
                    const isSig = pos === 4;
                    const isKombi = kombiPos.includes(pos);
                    let text = "";
                    if (isSig) {
                      text = isPersonen
                        ? (PERSON_MATRIX[String(sig)]?.signifikator || CARDS[sig].kw)
                        : CARDS[sig].kw;
                    } else if (isKombi && card) {
                      const lo=Math.min(sig,card),hi=Math.max(sig,card);
                      text = COMBOS[lo+"-"+hi] || "";
                    } else if (activeKeys[pos] && card) {
                      const src = isPersonen ? PERSON_MATRIX[String(card)] : MATRIX[String(card)];
                      text = src ? src[activeKeys[pos]] : "";
                    }
                    const cardDisplay = card ? (SYMBOLS[card]+" "+CARDS[card].name) : "–";
                    return {label:posLabels[pos], card:cardDisplay, text, isSig, isKombi:isKombi&&!isPersonen};
                  });

                  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Lenormandia</title>
                  <style>
                    body{font-family:Georgia,serif;color:#1a1a1a;background:white;margin:0;padding:24px 32px;}
                    h1{font-size:20px;font-weight:normal;text-align:center;margin:0 0 4px;}
                    .subtitle{text-align:center;font-size:11px;color:#888;margin:0 0 8px;letter-spacing:2px;}
                    .question{text-align:center;font-style:italic;color:#444;font-size:13px;margin:0 0 20px;padding:8px 16px;border:1px solid #ddd;border-radius:6px;}
                    .grid{display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:20px;}
                    .cell{border:1px solid #ccc;border-radius:6px;padding:10px 12px;min-height:80px;}
                    .cell.sig{border-color:#c8a96e;background:#fffdf8;}
                    .cell.kombi{border-color:#b8a05e;}
                    .label{font-size:8px;letter-spacing:2px;text-transform:uppercase;color:#888;margin-bottom:4px;}
                    .card{font-size:11px;color:#c8a96e;margin-bottom:5px;}
                    .text{font-size:11px;line-height:1.6;color:#333;}
                    .footer{text-align:center;font-size:9px;color:#aaa;margin-top:24px;padding-top:12px;border-top:1px solid #eee;letter-spacing:2px;}
                    @media print{body{padding:16px;} button{display:none;}}
                  </style></head><body>
                  <h1>${sigSymbol} ${cardName} · ${isPersonen?"Personen-Matrix":"Situations-Matrix"}</h1>
                  <p class="subtitle">ANNA BENOIR · LENORMAND MATRIX</p>
                  ${question ? `<p class="question">„${question}"</p>` : ""}
                  <div class="grid">${cells.map(c=>`
                    <div class="cell${c.isSig?" sig":c.isKombi?" kombi":""}">
                      <div class="label">${c.label}${c.isKombi?" ✦":""}</div>
                      <div class="card">${c.card}</div>
                      <div class="text">${c.text||"–"}</div>
                    </div>`).join("")}
                  </div>
                  <button onclick="window.print()" style="display:block;margin:0 auto 16px;padding:8px 24px;font-family:Georgia,serif;cursor:pointer;border:1px solid #c8a96e;background:#fffdf8;color:#c8a96e;border-radius:4px;font-size:12px;">🖨 Drucken / Als PDF speichern</button>
                  <p class="footer">ANNA BENOIR · LENORMAND MATRIX · www.AnnaBenoir.de</p>
                  </body></html>`;

                  const w = window.open("","_blank");
                  w.document.write(html);
                  w.document.close();
                }} style={{ background:lightMode?"rgba(200,168,224,0.18)":"rgba(200,169,110,0.1)", border:`1px solid ${lightMode?"#c8a8e0":"rgba(200,169,110,0.3)"}`, color:gold, padding:"4px 10px", borderRadius:4, cursor:"pointer", fontSize:10, fontFamily:"Georgia,serif" }}>🖨 Drucken</button>
                <button onClick={shareFrageToForum} disabled={shareFrageStatus==="sharing"}
                  style={{ background:lightMode?"rgba(200,168,224,0.18)":"rgba(200,169,110,0.1)", border:`1px solid ${lightMode?"#c8a8e0":"rgba(200,169,110,0.3)"}`, color: shareFrageStatus==="done" ? "#5a9a5a" : gold, padding:"4px 10px", borderRadius:4, cursor:"pointer", fontSize:10, fontFamily:"Georgia,serif", opacity: shareFrageStatus==="sharing"?0.6:1 }}>
                  {shareFrageStatus==="sharing" ? "Teilt…" : shareFrageStatus==="done" ? "✓ Geteilt" : shareFrageStatus==="error" ? "✕ Fehler" : "💬 Im Forum teilen"}
                </button>
                <button onClick={reset} style={{ background:"transparent", border:`1px solid ${lightMode?"rgba(80,30,120,0.3)":"rgba(200,169,110,0.15)"}`, color:lightMode?"#2a0850":"#5a4a34", padding:"4px 10px", borderRadius:4, cursor:"pointer", fontSize:10, fontFamily:"Georgia,serif" }}>✕ Neu</button>
              </div>
            </div>

            {/* 3x3 Result Grid */}
            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:8 }}>
              {Array.from({length:9}, (_,pos) => {
                const card = matrixCards[pos];
                const isSignifikator = pos === 4;
                const isKombi = mode !== "personen" && KOMBI_POSITIONS.includes(pos);
                const m = MATRIX[String(signifikator)];
                // Situation matrix fields per position
                const sitKeys = ["gendanken", null, "rat_der_engel", "warnung", null, null, "wo_es_herkommt", null, "ergebnis_und_wann"];
                // Personen matrix fields per position
                const perKeys = ["sternzeichen", "haarfarbe", "charakter", "figur", null, "beruf", "groesse", "alter", "woher"];
                const activeKeys = mode === "personen" ? perKeys : sitKeys;
                const cardForText = card ? (mode === "personen" ? PERSON_MATRIX[String(card)] : MATRIX[String(card)]) : null;
                const fixedText = activeKeys[pos] && cardForText ? cardForText[activeKeys[pos]] : null;
                const comboText = isKombi && card ? getCombo(signifikator, card) : null;

                return (
                  <div key={pos} style={{
                    background: isSignifikator ? "rgba(200,169,110,0.08)" : isKombi ? "rgba(200,169,110,0.04)" : "rgba(200,169,110,0.02)",
                    border: `1px solid ${isSignifikator ? gold : isKombi ? "rgba(200,169,110,0.2)" : "rgba(200,169,110,0.1)"}`,
                    borderRadius:8, padding:"10px 8px"
                  }}>
                    <div style={{ fontSize:10, letterSpacing:2, color: isKombi ? "rgba(212,184,120,0.8)" : "#8a7050", textTransform:"uppercase", marginBottom:5 }}>
                      {mode === "personen" ? ["Sternzeichen","Haarfarbe","Charakter","Figur","Signifikator","Beruf/Berufung","Größe","Alter","Woher"][pos] : POSITION_LABELS[pos]}{isKombi && mode !== "personen" ? " ✦" : ""}
                    </div>
                    {card && (
                      <div style={{ marginBottom:6, display:"flex", alignItems:"center", gap:4 }}>
                        <span style={{fontSize:14}}>{SYMBOLS[card]}</span>
                        <span style={{fontSize:8, color:gold}}>{CARDS[card].name}</span>
                      </div>
                    )}
                    {isSignifikator && (
                      <div style={{ fontSize:9, color:lightMode?"#2a0850":"#9a8a72", lineHeight:1.6 }}>
                        {mode === "personen"
                          ? (PERSON_MATRIX[String(signifikator)]?.signifikator || CARDS[signifikator].kw)
                          : CARDS[signifikator].kw}
                      </div>
                    )}
                    {isKombi && comboText && (
                      <div style={{ fontSize:13, color:lightMode?"#2a0850":"#d8c8a0", lineHeight:1.75 }}>{comboText}</div>
                    )}
                    {isKombi && !card && (
                      <div style={{ fontSize:9, color:lightMode?"#2a0850":"#3a2a18", fontStyle:"italic" }}>–</div>
                    )}
                    {isKombi && card && !comboText && (
                      <div style={{ fontSize:9, color:lightMode?"#2a0850":"#3a2a18", fontStyle:"italic" }}>–</div>
                    )}
                    {!isSignifikator && !isKombi && !card && (
                      <div style={{ fontSize:9, color:lightMode?"#2a0850":"#3a2a18", fontStyle:"italic" }}>–</div>
                    )}
                    {fixedText && (
                      <div style={{ fontSize:13, color:lightMode?"#2a0850":"#c0b090", lineHeight:1.75 }}>{fixedText}</div>
                    )}
                  </div>
                );
              })}
            </div>
          </>)}
        </>)}

        {/* ── FORUM / COMMUNITY ── */}
        {view === "forum" && viewedProfileId && (() => {
          const p = forumProfiles[viewedProfileId];
          const rank = forumRankForPostCount(p?.postCount || 0);
          const initial = (viewedProfileName || "?").trim().charAt(0).toUpperCase() || "?";
          const age = ageFromBirthdate(p?.birthdate);
          return (
            <div style={{ maxWidth:420, margin:"0 auto", padding:"20px 0", textAlign:"center" }}>
              <button onClick={() => { setViewedProfileId(null); setViewedProfileName(""); }}
                style={{ background:"transparent", border:"none", color:lightMode?"#2a0850":"#9a8060", cursor:"pointer", fontSize:12, marginBottom:18, padding:0, fontFamily:"Georgia,serif", display:"block" }}>← zurück zum Forum</button>
              <div style={{ width:64, height:64, borderRadius:"50%", background:"rgba(200,169,110,0.12)", border:`1px solid ${gold}`, display:"flex", alignItems:"center", justifyContent:"center", fontSize:26, color:gold, fontFamily:"Georgia,serif", margin:"0 auto 14px" }}>
                {initial}
              </div>
              <div style={{ fontSize:16, color:gold, marginBottom:6 }}>{viewedProfileName || "Mitglied"}{age && <span style={{ color:lightMode?"#2a0850":"#9a8060", fontSize:13 }}> · {age}</span>}</div>
              <div style={{ fontSize:11, color:lightMode?"#2a0850":"#7a6040", background:"rgba(200,169,110,0.08)", display:"inline-block", padding:"3px 10px", borderRadius:10, marginBottom:10 }}>{forumRoleLabel(p?.role)}</div>
              <div style={{ fontSize:12, color:gold, marginBottom:6 }}>{rank}</div>
              {p?.createdAt && <div style={{ fontSize:11, color:lightMode?"#2a0850":"#5a4a34", marginBottom:14 }}>Mitglied seit {new Date(p.createdAt).toLocaleDateString('de-DE', {month:"long", year:"numeric"})}</div>}
              {p?.bio && <div style={{ fontSize:13, color:lightMode?"#2a0850":"#d4c4a0", lineHeight:1.6, marginTop:14, whiteSpace:"pre-wrap", textAlign:"left", background:"rgba(200,169,110,0.03)", border:`1px solid ${lightMode?"rgba(80,30,120,0.3)":"rgba(200,169,110,0.15)"}`, borderRadius:8, padding:"14px 16px" }}>{p.bio}</div>}
              <div style={{ fontSize:11, color:lightMode?"#2a0850":"#5a4a34", marginTop:18 }}>{p?.postCount || 0} {p?.postCount === 1 ? "Beitrag oder Antwort" : "Beiträge &amp; Antworten"} im Forum</div>
            </div>
          );
        })()}

        {view === "forum" && !viewedProfileId && (
          <div style={{ maxWidth:"100%", margin:"0 auto" }}>

            {/* Untermenü — im Stream sitzt es unten direkt über der Status-Box, sonst hier oben */}
            {!(communityMode === "forum" && forumView === "liste" && forumStartTab === "stream") && <ForumSubNav />}

            {/* PROFIL */}
            {communityMode === "profil" && (
              <div style={{ maxWidth:420, margin:"0 auto", padding:"20px 0" }}>
                {!profileEditing && (
                  <div style={{ textAlign:"center" }}>
                    <div style={{ width:64, height:64, borderRadius:"50%", background:"rgba(200,169,110,0.12)", border:`1px solid ${gold}`, display:"flex", alignItems:"center", justifyContent:"center", fontSize:26, color:gold, fontFamily:"Georgia,serif", margin:"0 auto 14px" }}>
                      {(userDisplayName || "?").trim().charAt(0).toUpperCase() || "?"}
                    </div>
                    <div style={{ fontSize:16, color:gold, marginBottom:6 }}>{userDisplayName || "Noch kein Name hinterlegt"}{ageFromBirthdate(userBirthdate) && <span style={{ color:lightMode?"#2a0850":"#9a8060", fontSize:13 }}> · {ageFromBirthdate(userBirthdate)}</span>}</div>
                    <div style={{ fontSize:11, color:lightMode?"#2a0850":"#7a6040", background:"rgba(200,169,110,0.08)", display:"inline-block", padding:"3px 10px", borderRadius:10, marginBottom:14 }}>{forumRoleLabel(userRole)}</div>
                    {userBio && <div style={{ fontSize:13, color:lightMode?"#2a0850":"#d4c4a0", lineHeight:1.6, marginBottom:14, whiteSpace:"pre-wrap" }}>{userBio}</div>}
                    {userSignature && <div style={{ fontSize:11, color:lightMode?"#2a0850":"#7a6040", fontStyle:"italic", marginBottom:14, paddingTop:8, borderTop:`1px solid ${lightMode?"rgba(80,30,120,0.3)":"rgba(200,169,110,0.1)"}` }}>{userSignature}</div>}
                    <div style={{ fontSize:11, color:lightMode?"#2a0850":"#5a4a34", marginBottom:20 }}>{getUserEmail()}</div>
                    <button onClick={() => setProfileEditing(true)}
                      style={{ background:"rgba(200,169,110,0.12)", border:`1px solid ${gold}`, color:gold, padding:"8px 20px", borderRadius:7, cursor:"pointer", fontSize:12, fontFamily:"Georgia,serif" }}>
                      ✎ Profil bearbeiten
                    </button>
                  </div>
                )}

                {profileEditing && (
                  <ProfileEditBox
                    initialName={userDisplayName}
                    initialBio={userBio}
                    initialSignature={userSignature}
                    initialBirthdate={userBirthdate}
                    initialGender={userGender}
                    saveStatus={profileSaveStatus}
                    onSave={saveProfile}
                    onCancel={() => setProfileEditing(false)}
                    gold={gold}
                    lightMode={lightMode}
                  />
                )}
                {!profileEditing && <ForumStatsBar />}
              </div>
            )}

            {/* FORUM */}
            {communityMode === "forum" && (<>
            {forumError && (
              <div style={{ background:"rgba(180,80,60,0.1)", border:"1px solid rgba(180,80,60,0.3)", borderRadius:8, padding:"10px 14px", marginBottom:16, color:lightMode?"#9a2a1a":"#d09080", fontSize:12 }}>
                {forumError}
              </div>
            )}

            {/* KATEGORIEN-LISTE */}
            {forumView === "liste" && (
              <div>
                {forumStartTab === "kategorien" && (<>
                <div style={{ display:"flex", justifyContent:"flex-end", marginBottom:12 }}>
                  {isAdmin && (
                    <button onClick={() => setForumShowNewCat(v => !v)} style={{ background:"transparent", border:`1px solid ${lightMode?"rgba(80,30,120,0.3)":"rgba(200,169,110,0.2)"}`, color:lightMode?"#2a0850":"#7a6040", padding:"5px 12px", borderRadius:5, cursor:"pointer", fontSize:11, fontFamily:"Georgia,serif" }}>
                      {forumShowNewCat ? "✕ Abbrechen" : "+ Neue Kategorie"}
                    </button>
                  )}
                </div>

                {isAdmin && forumShowNewCat && (
                  <div style={{ background:"rgba(200,169,110,0.04)", border:`1px solid ${lightMode?"rgba(80,30,120,0.3)":"rgba(200,169,110,0.2)"}`, borderRadius:10, padding:16, marginBottom:16 }}>
                    <input placeholder="Name der Kategorie" value={forumNewCatName} onChange={e => setForumNewCatName(e.target.value)}
                      style={{ width:"100%", padding:"8px 10px", marginBottom:8, background:"rgba(200,169,110,0.04)", border:`1px solid ${lightMode?"rgba(80,30,120,0.3)":"rgba(200,169,110,0.2)"}`, borderRadius:6, color:lightMode?"#2a0850":"#d4c4a0", fontFamily:"Georgia,serif", fontSize:13, outline:"none", boxSizing:"border-box" }} />
                    <input placeholder="Beschreibung (optional, ein kurzer Satz)" value={forumNewCatDescription} onChange={e => setForumNewCatDescription(e.target.value)}
                      style={{ width:"100%", padding:"8px 10px", marginBottom:8, background:"rgba(200,169,110,0.04)", border:`1px solid ${lightMode?"rgba(80,30,120,0.3)":"rgba(200,169,110,0.2)"}`, borderRadius:6, color:lightMode?"#2a0850":"#d4c4a0", fontFamily:"Georgia,serif", fontSize:13, outline:"none", boxSizing:"border-box" }} />
                    <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:8 }}>
                      <div style={{ fontSize:9, color:lightMode?"#2a0850":"#7a6040", letterSpacing:1 }}>Icon</div>
                      <input placeholder="z.B. 💬" value={forumNewCatIcon} maxLength={4} onChange={e => setForumNewCatIcon(e.target.value)}
                        style={{ width:60, padding:"6px 8px", textAlign:"center", background:"rgba(200,169,110,0.04)", border:`1px solid ${lightMode?"rgba(80,30,120,0.3)":"rgba(200,169,110,0.2)"}`, borderRadius:6, color:lightMode?"#2a0850":"#d4c4a0", fontFamily:"Georgia,serif", fontSize:14, outline:"none" }} />
                      <div style={{ fontSize:9, color:lightMode?"#2a0850":"#5a4a34" }}>nur 1 Emoji, kein Text — Vorschau:</div>
                      <span style={{ fontSize:22 }}>{forumNewCatIcon}</span>
                    </div>
                    <div style={{ display:"flex", gap:8, marginBottom:8 }}>
                      {[["guest","🌍 Alle (auch Gäste)"],["member","👥 Nur Mitglieder"],["pro","⭐ Nur Pro"]].map(([v,l]) => (
                        <button key={v} onClick={() => setForumNewCatVisibility(v)} style={{ flex:1, background:forumNewCatVisibility===v?"rgba(200,169,110,0.15)":"transparent", border:`1px solid ${forumNewCatVisibility===v?gold:"rgba(200,169,110,0.2)"}`, color:forumNewCatVisibility===v?gold:"#7a6040", padding:"6px 8px", borderRadius:5, cursor:"pointer", fontSize:10, fontFamily:"Georgia,serif" }}>{l}</button>
                      ))}
                    </div>
                    <label style={{ display:"flex", alignItems:"center", gap:6, marginBottom:10, fontSize:11, color:lightMode?"#2a0850":"#9a8060", cursor:"pointer" }}>
                      <input type="checkbox" checked={forumNewCatGuestPost} onChange={e => setForumNewCatGuestPost(e.target.checked)} />
                      Gäste dürfen hier auch ohne Login schreiben (z.B. für Mitmach-Mittwoch)
                    </label>
                    <button onClick={() => createForumCategory("forum")} style={{ width:"100%", background:"rgba(200,169,110,0.12)", border:`1px solid ${gold}`, color:gold, padding:"8px", borderRadius:6, cursor:"pointer", fontSize:12, fontFamily:"Georgia,serif" }}>Kategorie anlegen</button>
                  </div>
                )}

                {forumCategories.length === 0 && (
                  <div style={{ textAlign:"center", color:lightMode?"#2a0850":"#7a6040", fontSize:13, padding:"30px 0" }}>Noch keine Kategorien vorhanden.</div>
                )}

                {forumCategories.map(cat => {
                  const locked = !forumCanEnterCategory(cat);
                  const glow = cat.hasUnread && !locked;
                  if (isAdmin && forumEditingCategoryId === cat.id) {
                    return (
                      <CategoryEditBox
                        lightMode={lightMode}
                        key={cat.id}
                        initialName={cat.name}
                        initialDescription={cat.description || ""}
                        initialIcon={cat.icon || "💬"}
                        initialVisibility={cat.visibility}
                        initialGuestPost={!!cat.guest_can_post}
                        onSave={(fields) => saveEditForumCategory(cat.id, fields)}
                        onCancel={() => setForumEditingCategoryId(null)}
                        gold={gold}
                      />
                    );
                  }
                  return (
                  <div key={cat.id} onClick={() => openForumCategory(cat)}
                    style={{ display:"flex", alignItems:"center", justifyContent:"space-between", gap:12, background: glow ? "rgba(200,169,110,0.1)" : cat.pinned ? "rgba(200,169,110,0.06)" : "rgba(200,169,110,0.03)", border:`1px solid ${glow ? gold : cat.pinned ? "rgba(200,169,110,0.35)" : "rgba(200,169,110,0.2)"}`, borderRadius:10, padding:"14px 16px", marginBottom:10, cursor:"pointer", opacity: locked ? 0.7 : 1, boxShadow: glow ? "0 0 14px rgba(200,169,110,0.18)" : "none" }}>
                    <div style={{ display:"flex", alignItems:"center", gap:12 }}>
                      <span style={{ fontSize:22, maxWidth:32, overflow:"hidden", flexShrink:0 }}>{(cat.icon || "💬").slice(0, 4)}</span>
                      <div>
                        <div style={{ fontSize:14, color:gold, display:"flex", alignItems:"center", gap:6 }}>
                          {cat.pinned && <span style={{fontSize:11}}>📌</span>}
                          {glow && <span style={{width:7, height:7, borderRadius:"50%", background:gold, display:"inline-block", flexShrink:0}}></span>}
                          <span style={{fontWeight: glow ? "bold" : "normal"}}>{cat.name}</span>
                          {cat.visibility==="pro" && <span style={{fontSize:9, color:"#9a7060"}}>⭐ PRO</span>}
                          {locked && <span style={{fontSize:10, color:lightMode?"#2a0850":"#7a6040"}}>🔒</span>}
                        </div>
                        {cat.description && <div style={{ fontSize:11, color:lightMode?"#2a0850":"#7a6040", fontStyle:"italic", marginTop:2 }}>{cat.description}</div>}
                        <div style={{ fontSize:10, color:lightMode?"#2a0850":"#5a4a34", marginTop:3 }}>
                          {cat.postCount || 0} {cat.postCount === 1 ? "Beitrag" : "Beiträge"}{locked && " · Login nötig"}
                        </div>
                      </div>
                    </div>
                    <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                      {isAdmin && (
                        <button onClick={e => { e.stopPropagation(); setForumEditingCategoryId(cat.id); }}
                          title="Kategorie bearbeiten"
                          style={{ background:"transparent", border:"none", color:lightMode?"#2a0850":"#9a8060", cursor:"pointer", fontSize:12 }}>✎</button>
                      )}
                      {isAdmin && (
                        <button onClick={e => { e.stopPropagation(); toggleForumCategoryPin(cat); }}
                          title={cat.pinned ? "Anpinnen lösen" : "Kategorie anpinnen"}
                          style={{ background: cat.pinned ? "rgba(200,169,110,0.15)" : "transparent", border:`1px solid ${cat.pinned ? gold : "rgba(200,169,110,0.25)"}`, color: cat.pinned ? gold : "#9a8060", cursor:"pointer", fontSize:13, padding:"4px 8px", borderRadius:5 }}>📌</button>
                      )}
                      {isAdmin && (
                        <button onClick={e => { e.stopPropagation(); if(window.confirm(`Kategorie "${cat.name}" wirklich löschen? Alle Beiträge darin gehen verloren.`)) deleteForumCategory(cat.id); }}
                          style={{ background:"transparent", border:"none", color:"#9a6050", cursor:"pointer", fontSize:14 }}>✕</button>
                      )}
                      <span style={{ color:lightMode?"#2a0850":"#5a4a34", fontSize:16 }}>{locked ? "🔒" : "→"}</span>
                    </div>
                  </div>
                  );
                })}

                {/* Echte Forum-Statistik (siehe loadForumCategories) statt Fake-Zahlen */}
                <ForumStatsBar />
                </>)}

                {forumStartTab === "stream" && (
                  <div>
                    <ForumSubNav />
                    {/* "Was machst du gerade?" — eigener Status in den Feed */}
                    {!isGuest ? (
                      <div style={{ background:lightMode?"rgba(200,168,224,0.10)":"rgba(200,169,110,0.04)", border:`1px solid ${lightMode?"rgba(200,168,224,0.45)":"rgba(200,169,110,0.25)"}`, borderRadius:12, padding:"12px 14px", marginBottom:16 }}>
                        <textarea value={streamStatusText} onChange={e => setStreamStatusText(e.target.value)} rows={2}
                          placeholder="Was machst du gerade?"
                          style={{ width:"100%", padding:"8px 10px", background:"rgba(200,169,110,0.04)", border:`1px solid ${lightMode?"rgba(80,30,120,0.3)":"rgba(200,169,110,0.2)"}`, borderRadius:7, color:lightMode?"#2a0850":"#d4c4a0", fontFamily:"Georgia,serif", fontSize:13, outline:"none", boxSizing:"border-box", resize:"none", lineHeight:1.5 }} />
                        <div style={{ display:"flex", justifyContent:"flex-end", marginTop:6 }}>
                          <button onClick={postStreamStatus} disabled={!streamStatusText.trim()} style={{ background:streamStatusText.trim()?(lightMode?"rgba(200,168,224,0.22)":"rgba(200,169,110,0.15)"):"transparent", border:`1px solid ${streamStatusText.trim()?(lightMode?"#c8a8e0":gold):"rgba(200,169,110,0.2)"}`, color:streamStatusText.trim()?gold:"#7a6040", padding:"6px 18px", borderRadius:6, cursor:streamStatusText.trim()?"pointer":"default", fontSize:12, fontFamily:"Georgia,serif" }}>Teilen</button>
                        </div>
                      </div>
                    ) : (
                      <div style={{ background:lightMode?"rgba(200,168,224,0.08)":"rgba(200,169,110,0.03)", border:`1px solid ${lightMode?"rgba(200,168,224,0.35)":"rgba(200,169,110,0.18)"}`, borderRadius:12, padding:"12px 14px", marginBottom:16, textAlign:"center", fontSize:12, color:lightMode?"#2a0850":"#9a8060" }}>
                        Melde dich an, um etwas zu teilen.
                      </div>
                    )}
                    {forumStreamLoading && forumStream.length === 0 && (
                      <div style={{ textAlign:"center", color:lightMode?"#2a0850":"#7a6040", fontSize:12, padding:"24px 0" }}>Lädt den Stream…</div>
                    )}
                    {!forumStreamLoading && forumStream.length === 0 && (
                      <div style={{ textAlign:"center", color:lightMode?"#2a0850":"#7a6040", fontSize:13, padding:"30px 0" }}>Noch keine Aktivität. Sei die Erste! ✨</div>
                    )}
                    {forumStream.map(ev => {
                      const icon = ev.kind === "post" ? (ev.isMatrix ? "🃏" : (ev.categoryIcon || "🕯️")) : ev.kind === "reply" ? "💬" : ev.kind === "like" ? "⭐" : ev.kind === "member" ? "🌱" : ev.kind === "quiz_highscore" ? "🏆" : ev.kind === "status" ? "🌸" : "✨";
                      const openTarget = () => {
                        if (ev.kind === "post" && ev.post) { const cat = forumCategories.find(c => c.id === ev.post.category_id); setForumActiveCategory(cat || {id: ev.post.category_id}); openForumPost(ev.post); }
                        else if (ev.postId) { loadAndOpenPostById(ev.postId); }
                      };
                      const clickable = ev.kind === "post" || ((ev.kind === "reply" || ev.kind === "like") && ev.postId);
                      const quizModeLabel = { kombis:"Kombinationen", zeit:"Blitz", person:"Personen", karte:"Kartenkunde", "3er":"3er-Kombis", "4er":"4er-Kombis" };
                      let headline;
                      if (ev.kind === "post") headline = <>hat ein neues Thema eröffnet{ev.category ? <> in <span style={{color:gold}}>{ev.category}</span></> : ""}</>;
                      else if (ev.kind === "reply") headline = <>hat geantwortet auf <span style={{color:gold}}>„{ev.postTitle}"</span></>;
                      else if (ev.kind === "like") headline = <>gefällt <span style={{color:gold}}>„{ev.postTitle}"</span></>;
                      else if (ev.kind === "member") headline = <>ist neu dabei 🌱</>;
                      else if (ev.kind === "quiz_highscore") headline = <>hat einen neuen Highscore: <span style={{color:gold}}>{ev.payload?.score}</span>{ev.payload?.mode ? <> ({quizModeLabel[ev.payload.mode] || ev.payload.mode})</> : ""}</>;
                      else if (ev.kind === "status") headline = <>schreibt:</>;
                      else headline = <>hat etwas getan</>;
                      return (
                        <div key={ev.key}
                          style={{ background:lightMode?"rgba(200,168,224,0.07)":"rgba(200,169,110,0.03)", border:`1px solid ${lightMode?"rgba(200,168,224,0.4)":"rgba(200,169,110,0.2)"}`, borderRadius:12, padding:"14px 16px", marginBottom:12 }}>
                          <div style={{ display:"flex", alignItems:"baseline", gap:8, flexWrap:"wrap" }}>
                            <span style={{ fontSize:16 }}>{icon}</span>
                            <span style={{ fontSize:13, color:lightMode?"#2a0850":"#d4c4a0" }}><span style={{ fontWeight:"bold" }}>{ev.actor}</span> {headline}</span>
                            <span style={{ fontSize:10, color:lightMode?"#6a4a90":"#7a6040", marginLeft:"auto", whiteSpace:"nowrap" }}>{streamTimeAgo(ev.when)}</span>
                            {ev.eventId && (isMod || ev.userId === getUserId()) && (
                              <button onClick={() => { if(window.confirm("Wirklich löschen?")) deleteStreamEvent(ev.eventId); }} title="Löschen" style={{ background:"transparent", border:"none", color:"#9a6050", cursor:"pointer", fontSize:12, padding:0 }}>✕</button>
                            )}
                          </div>
                          {ev.kind === "post" && (
                            <div style={{ marginTop:8 }}>
                              {forumEditingPostId === ev.post.id ? (
                                <InlinePostEditBox lightMode={lightMode}
                                  initialTitle={ev.post.title} initialBody={ev.post.body}
                                  onSave={(t,b) => saveStreamPostEdit(ev.post.id, t, b)}
                                  onCancel={() => setForumEditingPostId(null)} />
                              ) : (<>
                                {(forumCanEdit(ev.post, ev.post.user_id) || isMod || ev.post.user_id === getUserId()) && (
                                  <div style={{ display:"flex", justifyContent:"flex-end", gap:12, marginBottom:2 }}>
                                    {forumCanEdit(ev.post, ev.post.user_id) && (
                                      <button onClick={() => setForumEditingPostId(ev.post.id)} title="Bearbeiten" style={{ background:"transparent", border:"none", color:lightMode?"#2a0850":"#9a8060", cursor:"pointer", fontSize:12 }}>✎</button>
                                    )}
                                    {(isMod || ev.post.user_id === getUserId()) && (
                                      <button onClick={() => { if(window.confirm("Beitrag wirklich löschen?")) deleteStreamPost(ev.post.id); }} title="Löschen" style={{ background:"transparent", border:"none", color:"#9a6050", cursor:"pointer", fontSize:12 }}>✕</button>
                                    )}
                                  </div>
                                )}
                                <div style={{ fontSize:14, color:gold, marginBottom:5, fontWeight:"bold" }}>{ev.title}</div>
                                {ev.body && !ev.isMatrix && (() => {
                                  const LIMIT = 400;
                                  const expanded = streamPostExpanded[ev.post.id];
                                  const long = ev.body.length > LIMIT;
                                  const shown = (!long || expanded) ? ev.body : ev.body.slice(0, LIMIT).trimEnd() + "…";
                                  return (
                                    <div style={{ fontSize:12.5, color:lightMode?"#2a0850":"#c8b89a", lineHeight:1.6 }}>
                                      {renderTextWithVideos(shown)}
                                      {long && (
                                        <button onClick={() => setStreamPostExpanded(prev => ({...prev, [ev.post.id]: !expanded}))}
                                          style={{ background:"transparent", border:"none", color:gold, cursor:"pointer", fontSize:11.5, fontFamily:"Georgia,serif", padding:0, marginTop:4, display:"block" }}>
                                          {expanded ? "▲ weniger anzeigen" : "▼ mehr lesen"}
                                        </button>
                                      )}
                                    </div>
                                  );
                                })()}
                                {ev.isMatrix && ev.post?.matrix_data && (
                                  <div style={{ marginTop:10 }}>
                                    <ForumMatrixGrid data={ev.post.matrix_data} gold={gold} lightMode={lightMode} />
                                  </div>
                                )}
                              </>)}
                              <div style={{ marginTop:10, borderTop:`1px solid ${lightMode?"rgba(200,168,224,0.3)":"rgba(200,169,110,0.12)"}`, paddingTop:8 }}>
                                {(() => {
                                  const reps = ev.replies || [];
                                  const topLevel = reps.filter(r => !r.reply_to_id || !reps.some(x => x.id === r.reply_to_id)).sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
                                  const expanded = streamRepliesExpanded[ev.post.id];
                                  const shownTop = expanded ? topLevel : topLevel.slice(-2);
                                  return (<>
                                    {topLevel.length > 2 && !expanded && (
                                      <button onClick={() => setStreamRepliesExpanded(prev => ({...prev, [ev.post.id]: true}))}
                                        style={{ background:"transparent", border:"none", color:lightMode?"#6a4a90":"#9a8060", cursor:"pointer", fontSize:11, padding:0, fontFamily:"Georgia,serif", marginBottom:8, display:"block" }}>▸ alle {reps.length} Antworten anzeigen</button>
                                    )}
                                    {shownTop.map(top => renderStreamReplyNode(reps, ev.post.id, top, 0))}
                                  </>);
                                })()}
                                {!isGuest ? (
                                  <div style={{ marginTop:6 }}>
                                    {streamReplyTo[ev.post.id] && (
                                      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", fontSize:10, color:lightMode?"#2a0850":"#9a8060", marginBottom:4, background:"rgba(200,169,110,0.06)", padding:"3px 8px", borderRadius:5 }}>
                                        <span>↩ Antwort an {streamReplyTo[ev.post.id].name}</span>
                                        <button onClick={() => setStreamReplyTo(prev => { const n = {...prev}; delete n[ev.post.id]; return n; })} style={{ background:"transparent", border:"none", color:"#9a6050", cursor:"pointer", fontSize:10 }}>✕</button>
                                      </div>
                                    )}
                                    <div style={{ display:"flex", gap:6 }}>
                                    <input value={streamReplyDrafts[ev.post.id] || ""} onChange={e => setStreamReplyDrafts(prev => ({...prev, [ev.post.id]: e.target.value}))}
                                      onKeyDown={e => { if (e.key === "Enter") addStreamReply(ev.post.id); }}
                                      placeholder={streamReplyTo[ev.post.id] ? `Antwort an ${streamReplyTo[ev.post.id].name}…` : "Antworten…"}
                                      style={{ flex:1, minWidth:0, padding:"6px 10px", background:"rgba(200,169,110,0.04)", border:`1px solid ${lightMode?"rgba(80,30,120,0.3)":"rgba(200,169,110,0.2)"}`, borderRadius:6, color:lightMode?"#2a0850":"#d4c4a0", fontFamily:"Georgia,serif", fontSize:12, outline:"none", boxSizing:"border-box" }} />
                                    <button onClick={() => addStreamReply(ev.post.id)} style={{ background:lightMode?"rgba(200,168,224,0.18)":"rgba(200,169,110,0.12)", border:`1px solid ${lightMode?"#c8a8e0":gold}`, color:gold, padding:"6px 12px", borderRadius:6, cursor:"pointer", fontSize:12, fontFamily:"Georgia,serif", flexShrink:0 }}>➤</button>
                                    </div>
                                  </div>
                                ) : (
                                  <button onClick={() => setView("forum-login-noetig")} style={{ background:"transparent", border:"none", color:lightMode?"#6a4a90":"#9a8060", cursor:"pointer", fontSize:11, padding:0, fontFamily:"Georgia,serif", marginTop:4 }}>💬 Anmelden zum Antworten</button>
                                )}
                              </div>
                            </div>
                          )}
                          {ev.kind === "reply" && (
                            <div onClick={openTarget} style={{ marginTop:6, cursor:"pointer", fontSize:12.5, color:lightMode?"#2a0850":"#c8b89a", lineHeight:1.6, maxHeight:180, overflow:"hidden" }}>
                              {renderTextWithVideos(ev.body || "")}
                            </div>
                          )}
                          {ev.kind === "status" && ev.payload?.text && (
                            <div style={{ marginTop:6, fontSize:13.5, color:lightMode?"#2a0850":"#d4c4a0", lineHeight:1.6 }}>
                              {renderTextWithVideos(ev.payload.text)}
                            </div>
                          )}
                          {ev.eventId && (
                            <div style={{ marginTop:10, borderTop:`1px solid ${lightMode?"rgba(200,168,224,0.3)":"rgba(200,169,110,0.12)"}`, paddingTop:8 }}>
                              {(() => {
                                const cms = forumStreamComments[ev.eventId] || [];
                                const topLevel = cms.filter(c => !c.parent_id || !cms.some(x => x.id === c.parent_id)).sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
                                return topLevel.map(top => renderStreamCommentNode(cms, ev.eventId, top, 0));
                              })()}
                              {streamCommentsOpen[ev.eventId] ? (
                                <div style={{ marginTop:6 }}>
                                  {streamCommentReplyTo[ev.eventId] && (
                                    <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", fontSize:10, color:lightMode?"#2a0850":"#9a8060", marginBottom:4, background:"rgba(200,169,110,0.06)", padding:"3px 8px", borderRadius:5 }}>
                                      <span>↩ Antwort an {streamCommentReplyTo[ev.eventId].name}</span>
                                      <button onClick={() => setStreamCommentReplyTo(prev => { const n = {...prev}; delete n[ev.eventId]; return n; })} style={{ background:"transparent", border:"none", color:"#9a6050", cursor:"pointer", fontSize:10 }}>✕</button>
                                    </div>
                                  )}
                                  <div style={{ display:"flex", gap:6 }}>
                                    <input value={streamCommentDrafts[ev.eventId] || ""} onChange={e => setStreamCommentDrafts(prev => ({...prev, [ev.eventId]: e.target.value}))}
                                      onKeyDown={e => { if (e.key === "Enter") addStreamComment(ev.eventId); }}
                                      placeholder={streamCommentReplyTo[ev.eventId] ? `Antwort an ${streamCommentReplyTo[ev.eventId].name}…` : "Kommentieren…"}
                                      style={{ flex:1, minWidth:0, padding:"6px 10px", background:"rgba(200,169,110,0.04)", border:`1px solid ${lightMode?"rgba(80,30,120,0.3)":"rgba(200,169,110,0.2)"}`, borderRadius:6, color:lightMode?"#2a0850":"#d4c4a0", fontFamily:"Georgia,serif", fontSize:12, outline:"none", boxSizing:"border-box" }} />
                                    <button onClick={() => addStreamComment(ev.eventId)} style={{ background:lightMode?"rgba(200,168,224,0.18)":"rgba(200,169,110,0.12)", border:`1px solid ${lightMode?"#c8a8e0":gold}`, color:gold, padding:"6px 12px", borderRadius:6, cursor:"pointer", fontSize:12, fontFamily:"Georgia,serif", flexShrink:0 }}>➤</button>
                                  </div>
                                </div>
                              ) : (
                                <button onClick={() => { if (isGuest) { setView("forum-login-noetig"); return; } setStreamCommentsOpen(prev => ({...prev, [ev.eventId]: true})); }}
                                  style={{ background:"transparent", border:"none", color:lightMode?"#6a4a90":"#9a8060", cursor:"pointer", fontSize:11, padding:0, fontFamily:"Georgia,serif", marginTop:4 }}>💬 Kommentieren</button>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                    <ForumStatsBar />
                    {showScrollTop && (
                      <button onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })} title="Nach oben"
                        style={{ position:"fixed", bottom:24, right:24, zIndex:50, width:46, height:46, borderRadius:"50%", background:lightMode?"rgba(200,168,224,0.95)":"rgba(42,8,80,0.92)", border:`1px solid ${lightMode?"#c8a8e0":gold}`, color:lightMode?"#2a0850":gold, cursor:"pointer", fontSize:20, boxShadow:"0 3px 12px rgba(0,0,0,0.28)", display:"flex", alignItems:"center", justifyContent:"center" }}>⬆</button>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* KATEGORIE: BEITRAGSLISTE */}
            {forumView === "kategorie" && forumActiveCategory && (
              <div>
                <button onClick={() => { setForumView("liste"); setForumActiveCategory(null); }} style={{ background:"transparent", border:"none", color:lightMode?"#2a0850":"#9a8060", cursor:"pointer", fontSize:12, marginBottom:14, padding:0, fontFamily:"Georgia,serif" }}>← zurück zu den Kategorien</button>
                <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:16 }}>
                  <span style={{ fontSize:20 }}>{forumActiveCategory.icon}</span>
                  <div style={{ fontSize:16, color:gold }}>{forumActiveCategory.name}</div>
                </div>

                <div style={{ textAlign:"right", marginBottom:14 }}>
                  <button onClick={() => { if (isGuest) { setView("forum-login-noetig"); } else { setForumView("neu"); setForumError(""); } }} style={{ background:"rgba(200,169,110,0.12)", border:`1px solid ${gold}`, color:gold, padding:"7px 16px", borderRadius:6, cursor:"pointer", fontSize:12, fontFamily:"Georgia,serif" }}>
                    ✎ {forumActiveCategory.name === "Mitmach-Mittwoch" ? "Frage stellen" : "Neuer Beitrag"}
                  </button>
                </div>

                {forumPosts.length === 0 && (
                  <div style={{ textAlign:"center", color:lightMode?"#2a0850":"#7a6040", fontSize:13, padding:"30px 0" }}>Noch keine Beiträge — sei die/der Erste!</div>
                )}

                {forumPosts.map(post => {
                  const isUnread = !isGuest && post.user_id !== getUserId() && !forumReadPostIds.has(post.id);
                  return (
                  <div key={post.id}
                    style={{ display:"flex", alignItems:"center", justifyContent:"space-between", gap:10, background: post.pinned ? "rgba(200,169,110,0.07)" : isUnread ? "rgba(200,169,110,0.07)" : "rgba(200,169,110,0.03)", border:`1px solid ${post.pinned ? "rgba(200,169,110,0.35)" : isUnread ? "rgba(200,169,110,0.3)" : "rgba(200,169,110,0.15)"}`, borderRadius:8, padding:"12px 14px", marginBottom:8 }}>
                    <div onClick={() => openForumPost(post)} style={{ flex:1, minWidth:0, cursor:"pointer" }}>
                      <div style={{ fontSize:13, color:gold, marginBottom:4, display:"flex", alignItems:"center", gap:6 }}>
                        {post.pinned && <span>📌</span>}
                        {isUnread && <span style={{width:7, height:7, borderRadius:"50%", background:gold, display:"inline-block", flexShrink:0}}></span>}
                        <span style={{fontWeight: isUnread ? "bold" : "normal"}}>{post.title}</span>
                      </div>
                      <div style={{ fontSize:10, color:lightMode?"#2a0850":"#7a6040" }}>{post.display_name} · {new Date(post.created_at).toLocaleDateString('de-DE')}</div>
                    </div>
                    {isMod && (
                      <button onClick={e => { e.stopPropagation(); toggleForumPostPin(post); }}
                        title={post.pinned ? "Anpinnen lösen" : "Beitrag anpinnen"}
                        style={{ background: post.pinned ? "rgba(200,169,110,0.15)" : "transparent", border:`1px solid ${post.pinned ? gold : "rgba(200,169,110,0.25)"}`, color: post.pinned ? gold : "#9a8060", cursor:"pointer", fontSize:12, padding:"4px 8px", borderRadius:5, flexShrink:0 }}>📌</button>
                    )}
                  </div>
                  );
                })}
                <ForumStatsBar />
              </div>
            )}

            {/* NEUER BEITRAG */}
            {forumView === "neu" && forumActiveCategory && (
              <div>
                <button onClick={() => setForumView("kategorie")} style={{ background:"transparent", border:"none", color:lightMode?"#2a0850":"#9a8060", cursor:"pointer", fontSize:12, marginBottom:14, padding:0, fontFamily:"Georgia,serif" }}>← zurück</button>
                <div style={{ fontSize:14, color:gold, marginBottom:14 }}>✎ Neuer Beitrag in {forumActiveCategory.name}</div>
                {isGuest && (
                  <input placeholder="Dein Name (erscheint öffentlich)" value={forumNewName} onChange={e => setForumNewName(e.target.value)}
                    style={{ width:"100%", padding:"9px 12px", marginBottom:10, background:"rgba(200,169,110,0.04)", border:`1px solid ${lightMode?"rgba(80,30,120,0.3)":"rgba(200,169,110,0.2)"}`, borderRadius:6, color:lightMode?"#2a0850":"#d4c4a0", fontFamily:"Georgia,serif", fontSize:13, outline:"none", boxSizing:"border-box" }} />
                )}
                <input placeholder="Titel" value={forumNewTitle} onChange={e => setForumNewTitle(e.target.value)}
                  style={{ width:"100%", padding:"9px 12px", marginBottom:10, background:"rgba(200,169,110,0.04)", border:`1px solid ${lightMode?"rgba(80,30,120,0.3)":"rgba(200,169,110,0.2)"}`, borderRadius:6, color:lightMode?"#2a0850":"#d4c4a0", fontFamily:"Georgia,serif", fontSize:13, outline:"none", boxSizing:"border-box" }} />
                <textarea placeholder="Dein Text…" value={forumNewBody} onChange={e => setForumNewBody(e.target.value)} rows={6}
                  style={{ width:"100%", padding:"10px 12px", marginBottom:12, background:"rgba(200,169,110,0.04)", border:`1px solid ${lightMode?"rgba(80,30,120,0.3)":"rgba(200,169,110,0.2)"}`, borderRadius:7, color:lightMode?"#2a0850":"#d4c4a0", fontFamily:"Georgia,serif", fontSize:13, outline:"none", boxSizing:"border-box", resize:"none", lineHeight:1.6 }} />
                <button onClick={createForumPost} style={{ width:"100%", background:"rgba(200,169,110,0.12)", border:`1px solid ${gold}`, color:gold, padding:"10px", borderRadius:7, cursor:"pointer", fontSize:13, fontFamily:"Georgia,serif" }}>Veröffentlichen</button>
              </div>
            )}

            {/* POST-DETAIL MIT ANTWORTEN */}
            {forumView === "post" && forumActivePost && (
              <div>
                <button onClick={() => setForumView("kategorie")} style={{ background:"transparent", border:"none", color:lightMode?"#2a0850":"#9a8060", cursor:"pointer", fontSize:12, marginBottom:14, padding:0, fontFamily:"Georgia,serif" }}>← zurück zur Liste</button>
                <div style={{ background:"rgba(200,169,110,0.04)", border:`1px solid ${lightMode?"rgba(80,30,120,0.3)":"rgba(200,169,110,0.2)"}`, borderRadius:10, padding:"16px 18px", marginBottom:16 }}>
                  {forumEditingPostId === forumActivePost.id ? (
                    <InlinePostEditBox lightMode={lightMode}
                      initialTitle={forumActivePost.title}
                      initialBody={forumActivePost.body}
                      onSave={(newTitle, newBody) => saveEditForumPost(forumActivePost.id, newTitle, newBody)}
                      onCancel={() => setForumEditingPostId(null)}
                    />
                  ) : (<>
                    <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start" }}>
                      <div style={{ fontSize:15, color:gold, marginBottom:6 }}>{forumActivePost.title}</div>
                      <div style={{ display:"flex", gap:8, flexShrink:0 }}>
                        <button onClick={() => {
                            const url = `${window.location.origin}${window.location.pathname}#post-${forumActivePost.id}`;
                            navigator.clipboard.writeText(url).then(() => {
                              setLinkCopiedPostId(forumActivePost.id);
                              setTimeout(() => setLinkCopiedPostId(null), 2000);
                            });
                          }}
                          title="Link zu diesem Beitrag kopieren"
                          style={{ background:"transparent", border:"none", color: linkCopiedPostId===forumActivePost.id ? "#5a9a5a" : "#9a8060", cursor:"pointer", fontSize:12 }}>
                          {linkCopiedPostId===forumActivePost.id ? "✓ kopiert" : "🔗"}
                        </button>
                        {forumCanEdit(forumActivePost, forumActivePost.user_id) && (
                          <button onClick={() => startEditForumPost(forumActivePost)} style={{ background:"transparent", border:"none", color:lightMode?"#2a0850":"#9a8060", cursor:"pointer", fontSize:12 }}>✎</button>
                        )}
                        {(isMod || forumActivePost.user_id === getUserId()) && (
                          <button onClick={() => { if(window.confirm("Beitrag wirklich löschen?")) deleteForumPost(forumActivePost.id); }} style={{ background:"transparent", border:"none", color:"#9a6050", cursor:"pointer", fontSize:13 }}>✕</button>
                        )}
                      </div>
                    </div>
                    <div style={{ display:"flex", gap:14 }}>
                      <ForumProfileTag userId={forumActivePost.user_id} displayName={forumActivePost.display_name} />
                      <div style={{ flex:1, minWidth:0 }}>
                        <div style={{ fontSize:9, color:lightMode?"#2a0850":"#5a4a34", marginBottom:8 }}>{new Date(forumActivePost.created_at).toLocaleDateString('de-DE')}</div>
                        {forumActivePost.matrix_data ? (
                          <ForumMatrixGrid data={forumActivePost.matrix_data} gold={gold} lightMode={lightMode} />
                        ) : (
                          <div style={{ fontSize:13, color:lightMode?"#2a0850":"#d4c4a0", lineHeight:1.7 }}>{renderTextWithVideos(forumActivePost.body)}</div>
                        )}
                        {(() => {
                          const sig = forumActivePost.user_id === getUserId()
                            ? userSignature
                            : forumProfiles[forumActivePost.user_id]?.signature;
                          return sig ? (
                            <div style={{ marginTop:10, paddingTop:8, borderTop:`1px solid ${lightMode?"rgba(80,30,120,0.3)":"rgba(200,169,110,0.1)"}`, fontSize:11, color:lightMode?"#2a0850":"#7a6040", fontStyle:"italic" }}>{sig}</div>
                          ) : null;
                        })()}
                        <button onClick={() => toggleForumPostLike(forumActivePost.id)}
                          style={{ marginTop:10, background:"transparent", border:"none", color:forumMyPostLike?gold:"#9a8060", cursor:"pointer", fontSize:12, padding:0, fontFamily:"Georgia,serif", display:"flex", alignItems:"center", gap:5 }}>
                          {forumMyPostLike ? "★" : "☆"} {forumPostLikeCount}
                        </button>
                      </div>
                    </div>
                  </>)}
                </div>

                <div id="forum-reply-composer" style={{ marginBottom:18 }}>
                  {forumReplyToId && (
                    <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", fontSize:11, color:lightMode?"#2a0850":"#9a8060", marginBottom:6, background:"rgba(200,169,110,0.05)", padding:"5px 10px", borderRadius:6 }}>
                      <span>Antwort an {forumReplyToName}</span>
                      <button onClick={() => { setForumReplyToId(null); setForumReplyToName(""); }} style={{ background:"transparent", border:"none", color:"#9a6050", cursor:"pointer", fontSize:11 }}>✕</button>
                    </div>
                  )}
                  <textarea id="forum-reply-textarea" placeholder="Schreib eine Antwort…" value={forumReplyText} onChange={e => setForumReplyText(e.target.value)} rows={3}
                    style={{ width:"100%", padding:"9px 12px", marginBottom:8, background:"rgba(200,169,110,0.04)", border:`1px solid ${lightMode?"rgba(80,30,120,0.3)":"rgba(200,169,110,0.2)"}`, borderRadius:7, color:lightMode?"#2a0850":"#d4c4a0", fontFamily:"Georgia,serif", fontSize:12, outline:"none", boxSizing:"border-box", resize:"none", lineHeight:1.6 }} />
                  <button onClick={() => { if (isGuest) { setView("forum-login-noetig"); } else { createForumReply(); } }} style={{ background:"rgba(200,169,110,0.12)", border:`1px solid ${gold}`, color:gold, padding:"7px 18px", borderRadius:6, cursor:"pointer", fontSize:12, fontFamily:"Georgia,serif" }}>Antworten</button>
                </div>

                <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:10 }}>
                  <div style={{ fontSize:11, color:lightMode?"#2a0850":"#7a6040", letterSpacing:1, textTransform:"uppercase" }}>{forumReplies.length} Antworten</div>
                  <div style={{ display:"flex", gap:6 }}>
                    {[["neueste","Neueste"],["beliebteste","Beliebteste"]].map(([s,l]) => (
                      <button key={s} onClick={() => { setForumReplySort(s); setForumRepliesVisibleCount(20); }}
                        style={{ background:forumReplySort===s?"rgba(200,169,110,0.15)":"transparent", border:`1px solid ${forumReplySort===s?gold:"rgba(200,169,110,0.2)"}`, color:forumReplySort===s?gold:"#7a6040", padding:"4px 10px", borderRadius:6, cursor:"pointer", fontSize:10, fontFamily:"Georgia,serif" }}>
                        {l}
                      </button>
                    ))}
                  </div>
                </div>
                {(() => {
                  // Nur Top-Level-Antworten werden sortiert/paginiert — Unterantworten zu
                  // einer sichtbaren Top-Level-Antwort werden immer komplett mitgeladen,
                  // damit kein Gesprächsverlauf mitten drin abgeschnitten wird.
                  const topLevel = forumReplies.filter(r => !r.reply_to_id);
                  const sorted = [...topLevel].sort((a, b) => {
                    if (forumReplySort === "beliebteste") {
                      const diff = (forumLikeCounts[b.id] || 0) - (forumLikeCounts[a.id] || 0);
                      if (diff !== 0) return diff;
                      return new Date(b.created_at) - new Date(a.created_at); // bei Gleichstand: neueste zuerst
                    }
                    return new Date(b.created_at) - new Date(a.created_at); // "neueste"
                  });
                  const visible = sorted.slice(0, forumRepliesVisibleCount);
                  const hasMore = forumRepliesVisibleCount < sorted.length;
                  return (<>
                    {visible.map(reply => (
                      <ForumReplyThread key={reply.id} reply={reply} allReplies={forumReplies} depth={0} />
                    ))}
                    {hasMore && (
                      <div ref={el => {
                          if (!el) return;
                          const observer = new IntersectionObserver((entries) => {
                            if (entries[0].isIntersecting) {
                              setForumRepliesVisibleCount(prev => prev + 20);
                              observer.disconnect();
                            }
                          }, { rootMargin: "200px" });
                          observer.observe(el);
                        }}
                        style={{ textAlign:"center", padding:"10px 0" }}>
                        <span style={{ fontSize:11, color:lightMode?"#2a0850":"#7a6040" }}>Lade weitere Antworten…</span>
                      </div>
                    )}
                  </>);
                })()}

                <ForumStatsBar />
              </div>
            )}
            </>)}

            {/* KURSE — Übersicht folgt */}
            {communityMode === "kurse" && (<ContentErrorBoundary>
              {/* Zugriffssperre für alle ohne pro_full — aber erst urteilen, wenn die Rolle geladen
                  ist. Sonst sperrt es Admin/Pro kurz aus, solange userRole lädt (oder nach Token-Ablauf). */}
              {session && userRole === null ? (
                <div style={{ textAlign:"center", padding:"40px 20px", color:lightMode?"#2a0850":"#7a6040", fontSize:13 }}>Lädt…</div>
              ) : !isProFull ? (
                <div style={{ textAlign:"center", padding:"40px 20px" }}>
                  <div style={{ fontSize:32, marginBottom:14 }}>🎓</div>
                  <div style={{ fontSize:16, color:gold, marginBottom:10 }}>Kursbereich</div>
                  <div style={{ fontSize:13, color:lightMode?"#2a0850":"#7a6040", lineHeight:1.7, marginBottom:20, maxWidth:320, margin:"0 auto 20px" }}>
                    Dieser Bereich ist ausschließlich für Mitglieder mit vollem PRO-Zugang — nicht für die 14-tägige Testphase.
                  </div>
                  <a href="https://www.annabenoir.de/product-page/lenormand-matrix-app" target="_blank" rel="noopener noreferrer"
                    style={{ display:"inline-block", background:"rgba(200,169,110,0.12)", border:`1px solid ${gold}`, color:gold, padding:"10px 26px", borderRadius:6, textDecoration:"none", fontSize:13, letterSpacing:1 }}>
                    Jetzt freischalten →
                  </a>
                </div>
              ) : (<>

                {/* KURS-LISTE */}
                {kurseView === "liste" && (
                  <div>
                    {isAdmin && (
                      <div style={{ display:"flex", justifyContent:"flex-end", marginBottom:12 }}>
                        <button onClick={() => setKurseShowNewCat(v => !v)} style={{ background:"transparent", border:`1px solid ${lightMode?"rgba(80,30,120,0.3)":"rgba(200,169,110,0.2)"}`, color:lightMode?"#2a0850":"#7a6040", padding:"5px 12px", borderRadius:5, cursor:"pointer", fontSize:11, fontFamily:"Georgia,serif" }}>
                          {kurseShowNewCat ? "✕ Abbrechen" : "+ Neuer Kurs"}
                        </button>
                      </div>
                    )}
                    {isAdmin && kurseShowNewCat && (
                      <CategoryEditBox
                        lightMode={lightMode}
                        initialName="" initialDescription="" initialIcon="🎓"
                        initialVisibility="pro" initialGuestPost={false}
                        onSave={(fields) => { createForumCategory("kurse", fields); setKurseShowNewCat(false); }}
                        onCancel={() => setKurseShowNewCat(false)}
                        gold={gold}
                      />
                    )}
                    {kurseCategories.length === 0 && (
                      <div style={{ textAlign:"center", color:lightMode?"#2a0850":"#7a6040", fontSize:13, padding:"30px 0" }}>
                        Noch keine Kurse vorhanden — bald geht's los! 🌙
                      </div>
                    )}
                    {(() => {
                      const card = (cat, showReorder) => (
                        <div key={cat.id} onClick={() => { addKurseMerk(cat.id); setKurseActiveCategory(cat); setKurseView("kategorie"); loadKursePosts(cat.id); }}
                          style={{ display:"flex", alignItems:"center", gap:14, background:"rgba(200,169,110,0.03)", border:`1px solid rgba(200,169,110,0.2)`, borderRadius:10, padding:"14px 16px", marginBottom:10, cursor:"pointer" }}>
                          <span style={{ fontSize:28, flexShrink:0 }}>{cat.icon || "🎓"}</span>
                          <div style={{ flex:1, minWidth:0 }}>
                            <div style={{ fontSize:14, color:gold, marginBottom:3 }}>{cat.name}</div>
                            {cat.description && <div style={{ fontSize:11, color:lightMode?"#2a0850":"#7a6040", fontStyle:"italic" }}>{cat.description}</div>}
                            <div style={{ fontSize:10, color:lightMode?"#2a0850":"#5a4a34", marginTop:3 }}>{cat.postCount || 0} {cat.postCount === 1 ? "Lektion" : "Lektionen"}</div>
                          </div>
                          <button onClick={e => { e.stopPropagation(); toggleKurseMerk(cat.id); }} title={kurseMerkliste.has(cat.id) ? "Aus meinen Kursen entfernen" : "Zu meinen Kursen"}
                            style={{ background:"transparent", border:"none", cursor:"pointer", fontSize:16, color: kurseMerkliste.has(cat.id) ? gold : (lightMode?"#9a8ab0":"#7a6a54"), flexShrink:0, lineHeight:1 }}>{kurseMerkliste.has(cat.id) ? "★" : "☆"}</button>
                          {isAdmin && showReorder && (
                            <div style={{ display:"flex", flexDirection:"column", flexShrink:0 }}>
                              <button onClick={e => { e.stopPropagation(); moveKurseCategory(cat.id, "up"); }} title="nach oben"
                                style={{ background:"transparent", border:"none", color:lightMode?"#6a4a90":"#9a8060", cursor:"pointer", fontSize:11, lineHeight:1, padding:"1px 3px" }}>⬆</button>
                              <button onClick={e => { e.stopPropagation(); moveKurseCategory(cat.id, "down"); }} title="nach unten"
                                style={{ background:"transparent", border:"none", color:lightMode?"#6a4a90":"#9a8060", cursor:"pointer", fontSize:11, lineHeight:1, padding:"1px 3px" }}>⬇</button>
                            </div>
                          )}
                          {isAdmin && (
                            <button onClick={e => { e.stopPropagation(); setForumEditingCategoryId(cat.id); }} title="Kurs bearbeiten"
                              style={{ background:"transparent", border:"none", color:lightMode?"#2a0850":"#9a8060", cursor:"pointer", fontSize:12 }}>✎</button>
                          )}
                          {isAdmin && (
                            <button onClick={e => { e.stopPropagation(); if(window.confirm(`Kurs "${cat.name}" wirklich löschen?`)) deleteForumCategory(cat.id); }}
                              style={{ background:"transparent", border:"none", color:"#9a6050", cursor:"pointer", fontSize:14 }}>✕</button>
                          )}
                          <span style={{ color:lightMode?"#2a0850":"#5a4a34", fontSize:16 }}>→</span>
                        </div>
                      );
                      const meine = kurseCategories.filter(c => kurseMerkliste.has(c.id));
                      const weitere = kurseCategories.filter(c => !kurseMerkliste.has(c.id));
                      return (<>
                        {meine.length > 0 && (<>
                          <div style={{ fontSize:10, letterSpacing:2, color:gold, textTransform:"uppercase", marginBottom:8 }}>★ Meine Kurse</div>
                          {meine.map(cat => card(cat, false))}
                          {weitere.length > 0 && <div style={{ fontSize:10, letterSpacing:2, color:lightMode?"#2a0850":"#7a6040", textTransform:"uppercase", margin:"20px 0 8px" }}>Alle Kurse</div>}
                        </>)}
                        {weitere.map(cat => card(cat, true))}
                      </>);
                    })()}
                  </div>
                )}

                {/* LEKTIONEN-LISTE */}
                {kurseView === "kategorie" && kurseActiveCategory && (
                  <div>
                    <button onClick={() => { setKurseView("liste"); setKurseActiveCategory(null); setKursePosts([]); }}
                      style={{ background:"transparent", border:"none", color:lightMode?"#2a0850":"#9a8060", cursor:"pointer", fontSize:12, marginBottom:14, padding:0, fontFamily:"Georgia,serif" }}>← zurück zu den Kursen</button>
                    {isAdmin && forumEditingCategoryId === kurseActiveCategory.id ? (
                      <div style={{ marginBottom:16 }}>
                        <CategoryEditBox lightMode={lightMode} gold={gold}
                          initialName={kurseActiveCategory.name}
                          initialDescription={kurseActiveCategory.description || ""}
                          initialIcon={kurseActiveCategory.icon || "🎓"}
                          initialVisibility={kurseActiveCategory.visibility}
                          initialGuestPost={!!kurseActiveCategory.guest_can_post}
                          onSave={async (fields) => {
                            await saveEditForumCategory(kurseActiveCategory.id, fields);
                            const payload = { name: fields.name.trim(), description: fields.description.trim(), icon: (fields.icon || "🎓").trim().slice(0,4), visibility: fields.visibility, guest_can_post: fields.guestPost };
                            setKurseActiveCategory(prev => ({...prev, ...payload}));
                            setKurseCategories(prev => prev.map(c => c.id === kurseActiveCategory.id ? {...c, ...payload} : c));
                          }}
                          onCancel={() => setForumEditingCategoryId(null)}
                        />
                      </div>
                    ) : (<>
                      <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:4 }}>
                        <div style={{ fontSize:22, color:gold }}>{kurseActiveCategory.icon} {kurseActiveCategory.name}</div>
                        {isAdmin && <button onClick={() => setForumEditingCategoryId(kurseActiveCategory.id)} title="Kurs bearbeiten" style={{ background:"transparent", border:"none", color:lightMode?"#2a0850":"#9a8060", cursor:"pointer", fontSize:14 }}>✎</button>}
                      </div>
                      {kurseActiveCategory.description && <div style={{ fontSize:12, color:lightMode?"#2a0850":"#7a6040", fontStyle:"italic", marginBottom:16 }}>{kurseActiveCategory.description}</div>}
                    </>)}

                    {isAdmin && (
                      <div style={{ marginBottom:16 }}>
                        <button onClick={() => setKurseView("neu")} style={{ background:"rgba(200,169,110,0.08)", border:`1px solid rgba(200,169,110,0.3)`, color:gold, padding:"7px 16px", borderRadius:6, cursor:"pointer", fontSize:12, fontFamily:"Georgia,serif" }}>
                          + Neue Lektion
                        </button>
                      </div>
                    )}

                    {kursePosts.length === 0 && (
                      <div style={{ textAlign:"center", color:lightMode?"#2a0850":"#7a6040", fontSize:13, padding:"20px 0" }}>Noch keine Lektionen in diesem Kurs.</div>
                    )}
                    {kursePosts.map((post, idx) => (
                      <div key={post.id} onClick={() => { setKurseActivePost(post); setKurseView("post"); loadForumReplies(post.id); markForumPostRead(post.id); }}
                        style={{ display:"flex", alignItems:"center", gap:12, background:"rgba(200,169,110,0.03)", border:`1px solid ${lightMode?"rgba(80,30,120,0.3)":"rgba(200,169,110,0.15)"}`, borderRadius:8, padding:"12px 16px", marginBottom:8, cursor:"pointer" }}>
                        <div style={{ width:28, height:28, borderRadius:"50%", background:"rgba(200,169,110,0.1)", border:`1px solid ${gold}`, display:"flex", alignItems:"center", justifyContent:"center", fontSize:11, color:gold, flexShrink:0 }}>{idx + 1}</div>
                        <div style={{ flex:1, minWidth:0 }}>
                          <div style={{ fontSize:13, color:gold }}>{post.title}</div>
                          <div style={{ fontSize:10, color:lightMode?"#2a0850":"#5a4a34", marginTop:2 }}>{new Date(post.created_at).toLocaleDateString('de-DE')}</div>
                        </div>
                        <span style={{ color:lightMode?"#2a0850":"#5a4a34", fontSize:14 }}>→</span>
                      </div>
                    ))}
                  </div>
                )}

                {/* NEUE LEKTION ANLEGEN — nur Admin */}
                {kurseView === "neu" && kurseActiveCategory && isAdmin && (
                  <div>
                    <button onClick={() => setKurseView("kategorie")} style={{ background:"transparent", border:"none", color:lightMode?"#2a0850":"#9a8060", cursor:"pointer", fontSize:12, marginBottom:14, padding:0, fontFamily:"Georgia,serif" }}>← zurück</button>
                    <div style={{ fontSize:14, color:gold, marginBottom:16 }}>Neue Lektion in „{kurseActiveCategory.name}"</div>
                    <InlinePostEditBox lightMode={lightMode}
                      initialTitle="" initialBody=""
                      onSave={async (title, body) => {
                        if (!title.trim()) return;
                        try {
                          const r = await fetch(`${SUPABASE_URL}/rest/v1/forum_posts`, {
                            method:"POST", headers:{...dbHeaders(), "Prefer":"return=representation"},
                            body: JSON.stringify({ category_id: kurseActiveCategory.id, title: title.trim(), body: body.trim(), user_id: getUserId(), display_name: userDisplayName || "Anna" })
                          });
                          if (!r.ok) {
                            let msg = ""; try { msg = JSON.stringify(await r.json()); } catch {}
                            alert("Lektion konnte nicht gespeichert werden (" + r.status + "). " + msg);
                            return;
                          }
                          // Nicht auf die Insert-Antwort verlassen (RLS kann sie leer machen) —
                          // frisch vom Server laden, dann zurück zur Lektionsliste.
                          await loadKursePosts(kurseActiveCategory.id);
                          setKurseView("kategorie");
                        } catch (e) { alert("Speichern fehlgeschlagen: " + (e && e.message ? e.message : e)); }
                      }}
                      onCancel={() => setKurseView("kategorie")}
                    />
                  </div>
                )}

                {/* LEKTION DETAIL MIT FRAGEN/DISKUSSION */}
                {kurseView === "post" && kurseActivePost && (
                  <div>
                    <button onClick={() => { setKurseView("kategorie"); setKurseActivePost(null); }}
                      style={{ background:"transparent", border:"none", color:lightMode?"#2a0850":"#9a8060", cursor:"pointer", fontSize:12, marginBottom:14, padding:0, fontFamily:"Georgia,serif" }}>← zurück zum Kurs</button>
                    <div style={{ background:"rgba(200,169,110,0.04)", border:`1px solid ${lightMode?"rgba(80,30,120,0.3)":"rgba(200,169,110,0.2)"}`, borderRadius:10, padding:"16px 18px", marginBottom:16 }}>
                      {forumEditingPostId === kurseActivePost.id ? (
                        <InlinePostEditBox lightMode={lightMode}
                          initialTitle={kurseActivePost.title} initialBody={kurseActivePost.body}
                          onSave={async (newTitle, newBody) => {
                            if (!newTitle.trim()) return;
                            try {
                              await fetch(`${SUPABASE_URL}/rest/v1/forum_posts?id=eq.${kurseActivePost.id}`, {
                                method: "PATCH", headers: dbHeaders(),
                                body: JSON.stringify({ title: newTitle.trim(), body: newBody.trim() })
                              });
                              setKursePosts(prev => prev.map(p => p.id === kurseActivePost.id ? {...p, title:newTitle.trim(), body:newBody.trim()} : p));
                              setKurseActivePost(prev => ({...prev, title:newTitle.trim(), body:newBody.trim()}));
                              setForumEditingPostId(null);
                            } catch {}
                          }}
                          onCancel={() => setForumEditingPostId(null)}
                        />
                      ) : (<>
                        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:10 }}>
                          <div style={{ fontSize:16, color:gold }}>{kurseActivePost.title}</div>
                          {isAdmin && (
                            <div style={{ display:"flex", gap:8 }}>
                              <button onClick={() => setForumEditingPostId(kurseActivePost.id)} style={{ background:"transparent", border:"none", color:lightMode?"#2a0850":"#9a8060", cursor:"pointer", fontSize:12 }}>✎</button>
                              <button onClick={async () => { if(window.confirm("Lektion wirklich löschen?")) { await fetch(`${SUPABASE_URL}/rest/v1/forum_posts?id=eq.${kurseActivePost.id}`, {method:"DELETE", headers:dbHeaders()}); setKursePosts(prev => prev.filter(p => p.id !== kurseActivePost.id)); setKurseView("kategorie"); setKurseActivePost(null); } }} style={{ background:"transparent", border:"none", color:"#9a6050", cursor:"pointer", fontSize:13 }}>✕</button>
                            </div>
                          )}
                        </div>
                        <div style={{ fontSize:13, color:lightMode?"#2a0850":"#d4c4a0", lineHeight:1.7 }}>{renderTextWithVideos(kurseActivePost.body)}</div>
                      </>)}
                    </div>

                    {/* Fragen & Diskussion — nutzt dasselbe Reply-System wie das Forum */}
                    <div style={{ fontSize:11, color:lightMode?"#2a0850":"#7a6040", letterSpacing:1, textTransform:"uppercase", marginBottom:10 }}>
                      💬 Fragen & Diskussion ({forumReplies.length})
                    </div>
                    {forumReplies.filter(r => !r.reply_to_id).map(reply => (
                      <ForumReplyThread key={reply.id} reply={reply} allReplies={forumReplies} depth={0} />
                    ))}
                    {!isGuest && (
                      <div style={{ marginTop:14 }}>
                        {forumReplyToId && (
                          <div style={{ fontSize:11, color:lightMode?"#2a0850":"#7a6040", marginBottom:6 }}>
                            ↩ Antwort auf {forumReplyToName} &nbsp;
                            <button onClick={() => { setForumReplyToId(null); setForumReplyToName(""); }} style={{ background:"transparent", border:"none", color:"#9a6050", cursor:"pointer", fontSize:10 }}>✕</button>
                          </div>
                        )}
                        <textarea value={forumReplyText} onChange={e => setForumReplyText(e.target.value)} rows={3}
                          placeholder="Deine Frage oder Anmerkung zur Lektion…"
                          style={{ width:"100%", padding:"9px 12px", background:"rgba(200,169,110,0.04)", border:`1px solid ${lightMode?"rgba(80,30,120,0.3)":"rgba(200,169,110,0.2)"}`, borderRadius:7, color:lightMode?"#2a0850":"#d4c4a0", fontFamily:"Georgia,serif", fontSize:13, outline:"none", boxSizing:"border-box", resize:"none", lineHeight:1.6 }} />
                        <button onClick={() => createForumReply(kurseActivePost.id)}
                          style={{ marginTop:8, background:"rgba(200,169,110,0.12)", border:`1px solid ${gold}`, color:gold, padding:"8px 20px", borderRadius:6, cursor:"pointer", fontSize:12, fontFamily:"Georgia,serif" }}>
                          Frage stellen
                        </button>
                      </div>
                    )}
                  </div>
                )}

              </>)}
            </ContentErrorBoundary>)}
          </div>
        )}

        {/* ── SHOP — eigenständiger Bereich, unabhängig vom Forum ── */}
        {view === "shop" && (
          <div>
              <div style={{ textAlign:"center", marginBottom:24 }}>
                  <div style={{ fontSize:16, color:gold, marginBottom:6 }}>Wo möchtest du ankommen?</div>
                  <div style={{ fontSize:12, color:lightMode?"#2a0850":"#7a6040" }}>Drei Wege durch Lenormandia — such dir aus, wie tief du eintauchen willst.</div>
                </div>
                <style>{`
                  .shop-tiers { display: flex; flex-direction: column; gap: 14px; max-width: 420px; margin: 0 auto; }
                  @media (min-width: 880px) {
                    .shop-tiers { flex-direction: row; align-items: stretch; max-width: 980px; gap: 18px; }
                    .shop-tier { flex: 1 1 0; min-width: 0; display: flex; flex-direction: column; }
                  }
                `}</style>
                <div className="shop-tiers">

                  {/* GAST */}
                  <div className="shop-tier" style={{ background:"rgba(200,169,110,0.02)", border:`1px solid ${lightMode?"rgba(80,30,120,0.3)":"rgba(200,169,110,0.15)"}`, borderRadius:12, padding:"20px 22px" }}>
                    <div style={{ fontSize:14, color:lightMode?"#2a0850":"#9a8060", marginBottom:2 }}>🌙 Gast</div>
                    <div style={{ fontSize:11, color:lightMode?"#2a0850":"#5a4a34", marginBottom:14, fontStyle:"italic" }}>Steck einfach mal die Nase rein</div>
                    {["Willkommensseite & erster Einblick", "Eine Frage stellen, als kleiner Vorgeschmack", "Beim Mitmach-Mittwoch im Forum mitlesen"].map((f,i) => (
                      <div key={i} style={{ fontSize:12, color:lightMode?"#2a0850":"#c0b090", marginBottom:6, display:"flex", gap:6 }}><span>·</span><span>{f}</span></div>
                    ))}
                  </div>

                  {/* MITGLIED */}
                  <div className="shop-tier" style={{ background:"rgba(200,169,110,0.04)", border:`1px solid ${lightMode?"rgba(80,30,120,0.3)":"rgba(200,169,110,0.25)"}`, borderRadius:12, padding:"20px 22px" }}>
                    <div style={{ fontSize:14, color:gold, marginBottom:2 }}>🦉 Mitglied</div>
                    <div style={{ fontSize:11, color:lightMode?"#2a0850":"#7a6040", marginBottom:14, fontStyle:"italic" }}>Kostenlos dabei sein, mitfühlen, mitwachsen</div>
                    {["Alles aus Gast, und ein eigener Platz am Tisch", "Im Forum selbst schreiben & mitreden", "Tageskarten mit eigenem Tagebuch", "Spielerisch die Karten lernen im Quiz", "Eigenes Profil mit Rang & Signatur"].map((f,i) => (
                      <div key={i} style={{ fontSize:12, color:lightMode?"#2a0850":"#c0b090", marginBottom:6, display:"flex", gap:6 }}><span>·</span><span>{f}</span></div>
                    ))}
                    <a href="https://www.annabenoir.de/_paylink/AZ7k4iP9" target="_blank" rel="noopener noreferrer"
                      style={{ display:"block", textAlign:"center", marginTop:"auto", paddingTop:14 }}>
                      <span style={{ display:"block", background:"transparent", border:`1px solid ${lightMode?"rgba(80,30,120,0.3)":"rgba(200,169,110,0.3)"}`, color:lightMode?"#2a0850":"#9a8060", padding:"8px", borderRadius:7, fontSize:11, letterSpacing:0.5 }}>
                        ☕ Magst du Anna ein Käffchen spendieren?
                      </span>
                    </a>
                  </div>

                  {/* V.I.P. */}
                  <div className="shop-tier" style={{ background:"rgba(200,169,110,0.09)", border:`1.5px solid ${gold}`, borderRadius:12, padding:"20px 22px", boxShadow:"0 0 20px rgba(200,169,110,0.12)" }}>
                    <div style={{ fontSize:14, color:gold, marginBottom:2 }}>✨ V.I.P.</div>
                    <div style={{ fontSize:11, color:lightMode?"#2a0850":"#9a7a40", marginBottom:14, fontStyle:"italic" }}>Einmalig 85 € — und Lenormandia gehört für immer auch dir</div>
                    {["Alles aus Mitglied, und der ganze Schatz dazu", "Alle Kombinationen & alle 36 Karten im Detail", "Situations- & Personen-Matrix vollständig", "Zauberzettel & Writing-Werkzeug", "Kurse-Bereich mit allen Lektionen", "Vorrangige Beantwortung deiner Fragen durch Anna Benoir oder geprüfte Berater"].map((f,i) => (
                      <div key={i} style={{ fontSize:12, color:lightMode?"#2a0850":"#e0d0a8", marginBottom:6, display:"flex", gap:6 }}><span>·</span><span>{f}</span></div>
                    ))}
                    <a href="https://www.annabenoir.de/_paylink/AZ7k5c0S" target="_blank" rel="noopener noreferrer"
                      style={{ display:"block", textAlign:"center", marginTop:"auto", paddingTop:16, textDecoration:"none" }}>
                      <span style={{ display:"block", background:"rgba(200,169,110,0.18)", border:`1px solid ${gold}`, color:gold, padding:"10px", borderRadius:7, fontSize:13, letterSpacing:1 }}>
                        Jetzt V.I.P. werden →
                      </span>
                    </a>
                  </div>

                </div>
                <div style={{ textAlign:"center", fontSize:10, color:lightMode?"#2a0850":"#5a4a34", marginTop:18, fontStyle:"italic" }}>
                  Zum Vergleich: der Preis einer einzelnen Beratung — dafür bist du für immer dabei.
                </div>
          </div>
        )}

        {/* ── IMPRESSUM (Platzhalter) ── */}
        {view === "impressum" && (
          <div style={{ maxWidth:560, margin:"0 auto", padding:"20px 0" }}>
            <button onClick={() => setView("liesmich")}
              style={{ background:"transparent", border:"none", color:lightMode?"#2a0850":"#9a8060", cursor:"pointer", fontSize:12, marginBottom:18, padding:0, fontFamily:"Georgia,serif", display:"block" }}>← zurück</button>
            <div style={{ fontSize:16, color:gold, marginBottom:16 }}>Impressum</div>
            <div style={{ fontSize:13, color:lightMode?"#2a0850":"#9a8060", lineHeight:1.8 }}>
              Hier kommt bald das vollständige Impressum hin.
            </div>
          </div>
        )}

        {/* ── AGB (Platzhalter) ── */}
        {view === "agb" && (
          <div style={{ maxWidth:560, margin:"0 auto", padding:"20px 0" }}>
            <button onClick={() => setView("liesmich")}
              style={{ background:"transparent", border:"none", color:lightMode?"#2a0850":"#9a8060", cursor:"pointer", fontSize:12, marginBottom:18, padding:0, fontFamily:"Georgia,serif", display:"block" }}>← zurück</button>
            <div style={{ fontSize:16, color:gold, marginBottom:16 }}>Allgemeine Geschäftsbedingungen</div>
            <div style={{ fontSize:13, color:lightMode?"#2a0850":"#9a8060", lineHeight:1.8 }}>
              Hier kommen bald die vollständigen AGB hin.
            </div>
          </div>
        )}

        {/* ── QUIZ ── */}
        {view === "quiz" && (
          <div>
            <ForumSubNav />
            <div style={{ textAlign:"center", marginBottom:20 }}>
              <div style={{ fontSize:10, letterSpacing:4, color:lightMode?"#2a0850":"#7a6040", textTransform:"uppercase", marginBottom:6 }}>Lenormand Quiz</div>



              <div style={{ fontSize:16, color:gold, marginBottom:4 }}>
                {quizMode==="kombis" ? "Welche Deutung passt?" : quizMode==="zeit" ? "Wann tritt es ein?" : quizMode==="person" ? "Wer ist diese Person?" : "Was bedeutet diese Karte?"}
              </div>
                <div style={{ fontSize:12, color:lightMode?"#2a0850":"#5a4a34", marginBottom:12 }}>
                ✓ {quizScore.right} richtig &nbsp;·&nbsp; ✗ {quizScore.wrong} falsch
                {currentStreak >= 2 && <span style={{color:lightMode?"#5a1080":"#d4b878"}}> &nbsp;·&nbsp; 🔥 {currentStreak} in Folge</span>}
              </div>
              {/* Stats Übersicht */}
              <div style={{ display:"flex", justifyContent:"center", gap:10, flexWrap:"wrap", marginBottom:8 }}>
                {/* Heute + Streak */}
                {[
                  ["📊", "Heute", stats.todayRight + " / " + stats.todayTotal],
                  ["🔥", "Tage-Streak", stats.streakDays + " Tage"]
                ].map(([icon, label, val]) => (
                  <div key={label} style={{ background:"rgba(200,169,110,0.05)", border:`1px solid ${lightMode?"rgba(80,30,120,0.3)":"rgba(200,169,110,0.15)"}`, borderRadius:8, padding:"8px 16px", textAlign:"center", minWidth:90 }}>
                    <div style={{ fontSize:18 }}>{icon}</div>
                    <div style={{ fontSize:9, color:lightMode?"#2a0850":"#7a6040", letterSpacing:2, textTransform:"uppercase", marginTop:3 }}>{label}</div>
                    <div style={{ fontSize:13, color:lightMode?"#5a1080":"#c8a96e", marginTop:2 }}>{val}</div>
                  </div>
                ))}
              </div>
              {/* Separate Highscores */}
              <div style={{ display:"flex", justifyContent:"center", gap:8, flexWrap:"wrap", marginBottom:4 }}>
                {[["karte","🔮","Karten"], ["person","👤","Personen"], ["zeit","⏰","Zeiten"], ["kombis","🃏","Kombinationen"]].map(([m, icon, label]) => {
                  // Highscore für "Kombinationen" fasst die früher getrennten 2er/3er/4er-
                  // Bestwerte zusammen (Summe), damit beim Umstieg kein bereits erspielter
                  // Highscore einfach verschwindet.
                  const best = typeof stats.bestScore === "object"
                    ? (m === "kombis" ? (stats.bestScore["kombis"] || 0) + (stats.bestScore["3er"] || 0) + (stats.bestScore["4er"] || 0) : (stats.bestScore[m] || 0))
                    : (stats.bestScore || 0);
                  const isActive = quizMode === m;
                  return (
                    <div key={m}
                      onClick={() => { setQuizMode(m); setQuizCards(null); setQuizAnswer(null); setCurrentStreak(0); }}
                      style={{
                        background: isActive ? "rgba(200,169,110,0.12)" : "rgba(200,169,110,0.03)",
                        border: `1px solid ${isActive ? "#c8a96e" : "rgba(200,169,110,0.15)"}`,
                        borderRadius:8, padding:"10px 18px", textAlign:"center", minWidth:90,
                        cursor:"pointer", transition:"all 0.2s"
                      }}>
                      <div style={{ fontSize:18 }}>{icon}</div>
                      <div style={{ fontSize:8, color: isActive ? "#c8a96e" : "#7a6040", letterSpacing:2, textTransform:"uppercase", marginTop:2 }}>{label}</div>
                      <div style={{ fontSize:15, color: isActive ? "#c8a96e" : "#9a8060", marginTop:3, fontWeight: isActive ? "bold" : "normal" }}>🏆 {best}</div>
                    </div>
                  );
                })}
              </div>
            </div>

            {!quizCards && (
              <div style={{ textAlign:"center", marginTop:8 }}>
                <div style={{ fontSize:13, color:lightMode?"#2a0850":"#7a6040", marginBottom:14, fontStyle:"italic" }}>
                  {quizMode==="kombis" ? "Welche Deutung passt?" : quizMode==="zeit" ? "Wann tritt es ein?" : quizMode==="person" ? "Wer ist diese Person?" : (quizMode==="3er"||quizMode==="4er") ? "Was bedeutet diese Kombination?" : "Was bedeutet diese Karte?"}
                </div>
                {/* Trainings-Toggle */}
                <div style={{ display:"flex", alignItems:"center", justifyContent:"center", gap:10, marginBottom:16 }}>
                  <span style={{ fontSize:11, color: trainMode ? gold : "#5a4a34", fontFamily:"Georgia,serif" }}>🎓 Quiz</span>
                  <div onClick={() => setTrainMode(t => !t)}
                    style={{ width:42, height:22, background: trainMode ? "rgba(200,169,110,0.3)" : "rgba(200,169,110,0.08)", border:`1px solid ${trainMode ? gold : "rgba(200,169,110,0.25)"}`, borderRadius:11, cursor:"pointer", position:"relative", transition:"all 0.25s" }}>
                    <div style={{ position:"absolute", top:2, left: trainMode ? 22 : 2, width:16, height:16, background: trainMode ? gold : "#5a4a34", borderRadius:"50%", transition:"all 0.25s" }} />
                  </div>
                  <span style={{ fontSize:11, color: trainMode ? gold : "#5a4a34", fontFamily:"Georgia,serif" }}>📖 Training</span>
                </div>
                {trainMode && <div style={{ fontSize:10, color:lightMode?"#2a0850":"#7a6040", fontStyle:"italic", marginBottom:12 }}>1. Klick = Antwort zeigen · 2. Klick = nächste Frage</div>}
                <button onClick={startCurrentQuiz}
                  style={{ background:"rgba(200,169,110,0.12)", border:`1px solid ${gold}`, color:gold, padding:"12px 32px", borderRadius:8, cursor:"pointer", fontSize:14, fontFamily:"Georgia,serif", letterSpacing:1 }}>
                  {trainMode ? "📖 Training starten" : "🎓 Quiz starten"}
                </button>
              </div>
            )}

            {quizCards && (<>
              {/* Card display */}
              <div style={{ display:"flex", gap:10, justifyContent:"center", marginBottom:24, flexWrap:"wrap" }}>
                {(quizCards.karten ? quizCards.karten : quizCards.c2 ? [quizCards.c1, quizCards.c2] : [quizCards.c1]).map((num, i) => (
                  <div key={i} style={{ width: quizCards.karten && quizCards.karten.length > 2 ? 90 : 120, padding:"12px 8px", border:`1.5px solid ${gold}`, borderRadius:10, textAlign:"center", background:"rgba(200,169,110,0.05)" }}>
                    <div style={{ fontSize: quizCards.karten && quizCards.karten.length > 2 ? 28 : 36 }}>{SYMBOLS[num]}</div>
                    <div style={{ fontSize:10, color:gold, marginTop:6 }}>{num}. {CARDS[num].name}</div>
                    <div style={{ fontSize:8, color:lightMode?"#2a0850":"#7a6040", marginTop:3, lineHeight:1.4 }}>{CARDS[num].kw.split(',').slice(0,2).join(',')}</div>
                  </div>
                ))}
              </div>

              {/* TRAININGS-MODUS */}
              {trainMode ? (
                <div style={{ textAlign:"center" }}>
                  {!trainRevealed ? (
                    <button onClick={() => setTrainRevealed(true)}
                      style={{ background:"rgba(200,169,110,0.12)", border:`1px solid ${gold}`, color:gold, padding:"12px 32px", borderRadius:8, cursor:"pointer", fontSize:14, fontFamily:"Georgia,serif", letterSpacing:1, width:"100%", marginBottom:12 }}>
                      👁 Antwort zeigen
                    </button>
                  ) : (
                    <>
                      <div style={{ background:"rgba(200,169,110,0.04)", border:`1px solid ${lightMode?"rgba(80,30,120,0.3)":"rgba(200,169,110,0.25)"}`, borderRadius:10, padding:"16px 18px", marginBottom:16, textAlign:"left" }}>
                        {quizCards.label && <div style={{ fontSize:9, color:gold, letterSpacing:2, textTransform:"uppercase", marginBottom:8 }}>{quizCards.label}</div>}
                        <div style={{ fontSize:15, lineHeight:1.85, color:lightMode?"#2a0850":"#e0d0b0" }}>{quizCards.correct}</div>
                      </div>
                      <button onClick={startCurrentQuiz}
                        style={{ background:"rgba(200,169,110,0.12)", border:`1px solid ${gold}`, color:gold, padding:"10px 28px", borderRadius:6, cursor:"pointer", fontSize:13, fontFamily:"Georgia,serif" }}>
                        Nächste Karte →
                      </button>
                    </>
                  )}
                </div>
              ) : (
                <>
                  {/* QUIZ-MODUS: Optionen */}
                  <div style={{ display:"flex", flexDirection:"column", gap:10, marginBottom:20 }}>
                    {quizCards.options.map((opt, i) => {
                      const isCorrect = opt === quizCards.correct;
                      const isSelected = quizAnswer !== null;
                      let bg = "rgba(200,169,110,0.03)";
                      let border = lightMode ? "#7a3a9a" : "rgba(200,169,110,0.5)";
                      let color = lightMode ? "#2a0850" : "#c0b090";
                      if (isSelected && isCorrect && quizAnswer === "correct") { bg = "rgba(80,160,80,0.12)"; border = "#5a9a5a"; color = lightMode ? "#1a6a1a" : "#90d090"; }
                      else if (isSelected && isCorrect && quizAnswer === "wrong") { bg = "rgba(200,169,110,0.08)"; border = "#d4b878"; color = lightMode ? "#7a5408" : "#d4b878"; }
                      else if (isSelected && !isCorrect) { bg = "rgba(200,169,110,0.03)"; border = lightMode ? "rgba(122,58,154,0.4)" : "rgba(200,169,110,0.18)"; color = "#6a5a44"; }
                      return (
                        <button key={i} onClick={() => {
                          if (quizAnswer) return;
                          if (isCorrect) {
                            const newStreak = currentStreak + 1;
                            setCurrentStreak(newStreak);
                            setQuizAnswer("correct");
                            setQuizScore(s => {
                              const nr = s.right+1;
                              const nt = s.right+s.wrong+1;
                              updateStats(true, nr, nt);
                              const currentBest = typeof stats.bestScore === "object"
                                ? (stats.bestScore[quizMode] || 0)
                                : (stats.bestScore || 0);
                              if (nr > currentBest) setShowConfetti(true);
                              return {...s, right:nr};
                            });
                          } else {
                            setCurrentStreak(0);
                            setQuizAnswer("wrong");
                            let wrongCombo = null;
                            // Im "Kombinationen"-Modus kann die aktuelle Frage je nach Zufall
                            // eine 2er-, 3er- oder 4er-Kombination sein — quizCards.mode sagt,
                            // welche es tatsächlich war (von startQuiz/start3erQuiz/start4erQuiz
                            // gesetzt), quizMode allein würde hier nicht reichen.
                            const effectiveMode = quizCards?.mode || quizMode;
                            if (effectiveMode === "3er" || effectiveMode === "4er") {
                              const wrongCluster = CLUSTERS[effectiveMode].find(c => c.text === opt);
                              wrongCombo = wrongCluster ? wrongCluster.label : null;
                            } else if (quizMode === "kombis") {
                              const wrongKey = Object.keys(COMBOS).find(k => trimCombo(COMBOS[k]) === opt || COMBOS[k] === opt);
                              wrongCombo = wrongKey ? `${CARDS[wrongKey.split("-")[0]].name} + ${CARDS[wrongKey.split("-")[1]].name}` : null;
                            } else if (quizMode === "zeit") {
                              const wrongKey = Object.keys(TIME_QUIZ).find(k => TIME_QUIZ[k] === opt);
                              wrongCombo = wrongKey ? CARDS[String(wrongKey)].name : null;
                            } else if (quizMode === "person") {
                              const wrongKey = Object.keys(PERSON_SIG).find(k => PERSON_SIG[k] === opt);
                              wrongCombo = wrongKey ? CARDS[String(wrongKey)].name : null;
                            } else if (quizMode === "karte") {
                              const wrongKey = Object.keys(CARDS).find(k => CARDS[k].kw === opt);
                              wrongCombo = wrongKey ? CARDS[String(wrongKey)].name : null;
                            }
                            setQuizCards(prev => ({...prev, selectedWrong: opt, selectedWrongCombo: wrongCombo}));
                            setQuizScore(s => {
                              updateStats(false, s.right, s.right+s.wrong+1);
                              return {...s, wrong:s.wrong+1};
                            });
                          }
                        }}
                          style={{ background:bg, border:`1.5px solid ${border}`, borderRadius:8, padding:"12px 16px", cursor:quizAnswer?"default":"pointer", color, fontFamily:"Georgia,serif", fontSize:13, textAlign:"left", lineHeight:1.6, transition:"all 0.3s" }}>
                          {isSelected && isCorrect && "✓ "}{opt}
                        </button>
                      );
                    })}
                  </div>

                  {/* Result + Next */}
                  {quizAnswer && (
                    <div style={{ textAlign:"center" }}>
                      <div style={{ fontSize:14, color: quizAnswer==="correct" ? "#90d090" : "#c87a6a", marginBottom:12 }}>
                        {quizAnswer==="correct" ? "🎉 Richtig!" : "❌ Leider falsch!"}
                      </div>
                      {quizAnswer === "wrong" && (
                        <div style={{ background:"rgba(200,169,110,0.04)", border:`1px solid ${lightMode?"rgba(80,30,120,0.3)":"rgba(200,169,110,0.2)"}`, borderRadius:8, padding:"12px 16px", marginBottom:16, fontSize:13, color:lightMode?"#2a0850":"#c0b090", textAlign:"left", lineHeight:1.6 }}>
                          <div style={{ fontSize:9, color:"#c87a6a", letterSpacing:3, textTransform:"uppercase", marginBottom:6 }}>Deine Antwort war:</div>
                          {quizCards.selectedWrongCombo && (
                            <div style={{ fontSize:10, color:lightMode?"#5a1080":"#c8a96e", marginBottom:6 }}>{quizCards.selectedWrongCombo}</div>
                          )}
                          <div style={{ fontSize:12, color:lightMode?"#2a0850":"#9a8a72" }}>{quizCards.selectedWrong || "–"}</div>
                        </div>
                      )}
                      <button onClick={startCurrentQuiz}
                        style={{ background:"rgba(200,169,110,0.12)", border:`1px solid ${gold}`, color:gold, padding:"10px 28px", borderRadius:6, cursor:"pointer", fontSize:13, fontFamily:"Georgia,serif" }}>
                        Nächste Frage →
                      </button>
                    </div>
                  )}
                </>
              )}
            </>)}
          </div>
        )}

        {/* ── TAGEBUCH ── */}
                {view === "tagebuch" && (
          <div style={{ paddingBottom:30 }}>

            {/* Untermenü */}
            <DailySubNav />

            {/* TAGEBUCH */}
            {dailyMode === "tagebuch" && (
              <div>
                <div style={{ textAlign:"center", marginBottom:20 }}>
                  <div style={{ display:"flex", alignItems:"center", justifyContent:"center", gap:16, marginBottom:12 }}>
                    <button onClick={() => navigateDay(-1)}
                      style={{ background:"transparent", border:`1px solid ${lightMode?"rgba(80,30,120,0.3)":"rgba(200,169,110,0.2)"}`, color:gold, width:32, height:32, borderRadius:"50%", cursor:"pointer", fontSize:16, display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0 }}>‹</button>
                    <div style={{ fontSize:9, letterSpacing:4, color:lightMode?"#2a0850":"#7a6040", textTransform:"uppercase" }}>
                      Tageskombination · {formatDate(selectedDateKey)}
                      {isToday && <span style={{ marginLeft:6, color:gold, fontSize:8 }}>● heute</span>}
                    </div>
                    <button onClick={() => navigateDay(1)} disabled={isToday}
                      style={{ background:"transparent", border:`1px solid ${lightMode?"rgba(80,30,120,0.3)":"rgba(200,169,110,0.2)"}`, color:isToday?"#3a2a18":gold, width:32, height:32, borderRadius:"50%", cursor:isToday?"default":"pointer", fontSize:16, display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0, opacity:isToday?0.3:1 }}>›</button>
                  </div>
                  <div style={{ display:"flex", gap:16, justifyContent:"center", marginBottom:10 }}>
                    {[selectedCard.c1, selectedCard.c2].map((num, i) => (
                      <div key={i} style={{ textAlign:"center" }}>
                        <div style={{ fontSize:44 }}>{SYMBOLS[num]}</div>
                        <div style={{ fontSize:13, color:gold, marginTop:4 }}>{num}. {CARDS[num].name}</div>
                        <div style={{ fontSize:10, color:lightMode?"#2a0850":"#7a6040", fontStyle:"italic", marginTop:2 }}>{CARDS[num].kw.split(",").slice(0,2).join(",")}</div>
                      </div>
                    ))}
                  </div>
                </div>
                <div style={{ marginBottom:14 }}>
                  <div style={{ fontSize:11, color:lightMode?"#2a0850":gold, letterSpacing:1, marginBottom:6, display:"flex", alignItems:"center", gap:8 }}>
                    💭 Gedanken
                    {tagebuchSaveStatus === "saving" && <span style={{ fontSize:9, color:lightMode?"#2a0850":"#9a8060", letterSpacing:0, textTransform:"none" }}>speichert…</span>}
                    {tagebuchSaveStatus === "saved" && <span style={{ fontSize:9, color:"#5a9a5a", letterSpacing:0, textTransform:"none" }}>✓ gespeichert</span>}
                  </div>
                  <textarea placeholder={getUserId() ? "Was siehst du in dieser Kombination?" : "Zum Schreiben bitte einloggen — kein Eintrag geht dabei verloren."} value={selectedEntry.gedanken} onChange={e => updateTagebuch("gedanken", e.target.value)} rows={4}
                    style={{ width:"100%", padding:"10px 12px", background:"rgba(200,169,110,0.04)", border:`1px solid ${lightMode?"rgba(80,30,120,0.3)":"rgba(200,169,110,0.2)"}`, borderRadius:7, color:lightMode?"#2a0850":"#d4c4a0", fontFamily:"Georgia,serif", fontSize:13, outline:"none", boxSizing:"border-box", resize:"none", lineHeight:1.6 }} />
                </div>
                <div style={{ marginBottom:14 }}>
                  <div style={{ fontSize:11, color:lightMode?"#2a0850":gold, letterSpacing:1, marginBottom:6 }}>🌙 Reflexionen</div>
                  <textarea placeholder="Was hat sich bewahrheitet?" value={selectedEntry.reflexionen} onChange={e => updateTagebuch("reflexionen", e.target.value)} rows={4}
                    style={{ width:"100%", padding:"10px 12px", background:"rgba(200,169,110,0.04)", border:`1px solid ${lightMode?"rgba(80,30,120,0.3)":"rgba(200,169,110,0.2)"}`, borderRadius:7, color:lightMode?"#2a0850":"#d4c4a0", fontFamily:"Georgia,serif", fontSize:13, outline:"none", boxSizing:"border-box", resize:"none", lineHeight:1.6 }} />
                </div>
                <div style={{ marginBottom:18 }}>
                  <div style={{ fontSize:11, color:lightMode?"#2a0850":gold, letterSpacing:1, marginBottom:6 }}>📝 Resümee</div>
                  <textarea placeholder="Das Fazit des Tages…" value={selectedEntry.resumee} onChange={e => updateTagebuch("resumee", e.target.value)} rows={3}
                    style={{ width:"100%", padding:"10px 12px", background:"rgba(200,169,110,0.04)", border:`1px solid ${lightMode?"rgba(80,30,120,0.3)":"rgba(200,169,110,0.2)"}`, borderRadius:7, color:lightMode?"#2a0850":"#d4c4a0", fontFamily:"Georgia,serif", fontSize:13, outline:"none", boxSizing:"border-box", resize:"none", lineHeight:1.6 }} />
                </div>
                <div style={{ textAlign:"center", marginBottom:20 }}>
                  {!tippVisible ? (
                    <button onClick={() => setTippVisible(true)}
                      style={{ background:lightMode?"rgba(200,168,224,0.18)":"rgba(200,169,110,0.1)", border:`1px solid ${lightMode?"#c8a8e0":gold}`, color:gold, padding:"12px 28px", borderRadius:8, cursor:"pointer", fontSize:14, fontFamily:"Georgia,serif", letterSpacing:1 }}>
                      ✨ Tipp vom Universum
                    </button>
                  ) : (
                    <div style={{ background:"rgba(200,169,110,0.04)", border:`1px solid ${lightMode?"rgba(80,30,120,0.3)":"rgba(200,169,110,0.25)"}`, borderRadius:10, padding:"16px 18px", textAlign:"left" }}>
                      <div style={{ fontSize:9, letterSpacing:3, color:lightMode?"#2a0850":"#7a6040", textTransform:"uppercase", marginBottom:10 }}>✨ Was Emanuel sagt</div>
                      <div style={{ fontSize:14, lineHeight:1.85, color:lightMode?"#2a0850":"#e0d0b0" }}>{COMBOS[selectedCard.comboKey] || "Vertraue deiner Intuition."}</div>
                      <button onClick={() => setTippVisible(false)} style={{ marginTop:12, background:"transparent", border:`1px solid ${lightMode?"rgba(80,30,120,0.3)":"rgba(200,169,110,0.15)"}`, color:lightMode?"#2a0850":"#5a4a34", padding:"4px 12px", borderRadius:4, cursor:"pointer", fontSize:10, fontFamily:"Georgia,serif" }}>✕ Schließen</button>
                    </div>
                  )}
                </div>
                <div style={{ textAlign:"center", borderTop:`1px solid ${lightMode?"rgba(80,30,120,0.3)":"rgba(200,169,110,0.1)"}`, paddingTop:16, display:"flex", gap:10, justifyContent:"center", flexWrap:"wrap" }}>
                  <button onClick={druckeTagebuch} style={{ background:"transparent", border:`1px solid ${lightMode?"rgba(80,30,120,0.3)":"rgba(200,169,110,0.25)"}`, color:lightMode?"#2a0850":"#7a6040", padding:"8px 20px", borderRadius:6, cursor:"pointer", fontSize:12, fontFamily:"Georgia,serif", letterSpacing:1 }}>
                    🖨️ Drucken
                  </button>
                  <button onClick={() => { setShareTageskarteOpen(true); setShareTageskarteIncludeNotes(false); setShareTageskarteStatus(""); }}
                    style={{ background:"transparent", border:`1px solid ${lightMode?"rgba(80,30,120,0.3)":"rgba(200,169,110,0.25)"}`, color:lightMode?"#2a0850":"#7a6040", padding:"8px 20px", borderRadius:6, cursor:"pointer", fontSize:12, fontFamily:"Georgia,serif", letterSpacing:1 }}>
                    💬 Im Forum teilen
                  </button>
                </div>

                {shareTageskarteOpen && (
                  <div style={{ position:"fixed", inset:0, background:lightMode?"rgba(80,30,120,0.4)":"rgba(8,5,18,0.85)", display:"flex", alignItems:"center", justifyContent:"center", zIndex:1500, padding:20 }}
                    onClick={() => { if (shareTageskarteStatus !== "sharing") { setShareTageskarteOpen(false); setShareTageskarteStatus(""); } }}>
                    <div onClick={e => e.stopPropagation()}
                      style={{ background:lightMode?"#f0e8f8":"#0f0a1a", border:`1px solid ${lightMode?"rgba(80,30,120,0.3)":"rgba(200,169,110,0.3)"}`, borderRadius:12, padding:"24px 22px", maxWidth:340, width:"100%", textAlign:"center" }}>
                      {shareTageskarteStatus === "done" ? (
                        <div style={{ color:gold, fontSize:14 }}>✨ Geteilt! Du findest deinen Beitrag unter „Tageskarten" im Forum.</div>
                      ) : shareTageskarteStatus === "error" ? (
                        <div>
                          <div style={{ color:"#c87a6a", fontSize:13, marginBottom:14 }}>Konnte nicht geteilt werden. Versuch's gleich noch mal.</div>
                          <button onClick={() => { setShareTageskarteOpen(false); setShareTageskarteStatus(""); }} style={{ background:"transparent", border:`1px solid ${lightMode?"rgba(80,30,120,0.3)":"rgba(200,169,110,0.2)"}`, color:lightMode?"#2a0850":"#9a8060", padding:"7px 16px", borderRadius:6, cursor:"pointer", fontSize:12, fontFamily:"Georgia,serif" }}>Schließen</button>
                        </div>
                      ) : (
                        <>
                          <div style={{ fontSize:14, color:gold, marginBottom:14 }}>Tageskombination teilen</div>
                          <div style={{ fontSize:12, color:lightMode?"#2a0850":"#9a8060", marginBottom:16, lineHeight:1.6 }}>
                            {SYMBOLS[selectedCard.c1]}{SYMBOLS[selectedCard.c2]} {CARDS[selectedCard.c1].name} &amp; {CARDS[selectedCard.c2].name} — {formatDate(selectedDateKey)}
                          </div>
                          <label style={{ display:"flex", alignItems:"center", gap:8, marginBottom:20, fontSize:12, color:lightMode?"#2a0850":"#d4c4a0", cursor:"pointer", textAlign:"left" }}>
                            <input type="checkbox" checked={shareTageskarteIncludeNotes} onChange={e => setShareTageskarteIncludeNotes(e.target.checked)} />
                            Meine Notizen (Gedanken, Reflexionen, Resümee) mit teilen
                          </label>
                          <div style={{ display:"flex", gap:8 }}>
                            <button onClick={() => shareTageskarteToForum(shareTageskarteIncludeNotes)} disabled={shareTageskarteStatus==="sharing"}
                              style={{ flex:1, background:"rgba(200,169,110,0.12)", border:`1px solid ${gold}`, color:gold, padding:"9px", borderRadius:7, cursor:"pointer", fontSize:13, fontFamily:"Georgia,serif", opacity:shareTageskarteStatus==="sharing"?0.6:1 }}>
                              {shareTageskarteStatus==="sharing" ? "Teilt…" : "Teilen"}
                            </button>
                            <button onClick={() => setShareTageskarteOpen(false)} disabled={shareTageskarteStatus==="sharing"}
                              style={{ background:"transparent", border:`1px solid ${lightMode?"rgba(80,30,120,0.3)":"rgba(200,169,110,0.2)"}`, color:lightMode?"#2a0850":"#9a8060", padding:"9px 16px", borderRadius:7, cursor:"pointer", fontSize:13, fontFamily:"Georgia,serif" }}>
                              Abbrechen
                            </button>
                          </div>
                        </>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}


          </div>
        )}

        {/* ── WRITING ── */}
        {view === "tagebuch" && dailyMode === "writing" && (
          <div style={{ paddingBottom:30 }}>
            {writingView === "projekt" && (
              <div>
                <div style={{ textAlign:"center", marginBottom:20 }}>
                  <div style={{ fontSize:10, letterSpacing:4, color:lightMode?"#2a0850":"#7a6040", textTransform:"uppercase", marginBottom:6 }}>✍️ Writing</div>
                  <div style={{ fontSize:16, color:gold, marginBottom:4 }}>Woran arbeitest du heute?</div>
                </div>

                {/* Ordner / Projekte */}
                <div style={{ marginBottom:20 }}>
                  <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:8 }}>
                    <div style={{ fontSize:10, color:lightMode?"#2a0850":"#7a6040", letterSpacing:2, textTransform:"uppercase" }}>📁 Projekte</div>
                    <div style={{ display:"flex", gap:6 }}>
                      {emptyProjectsCount > 0 && (
                        <button onClick={cleanupEmptyProjects} title="Löscht alle Sessions, die noch nirgends Text enthalten"
                          style={{ background:"transparent", border:`1px solid ${lightMode?"rgba(80,30,120,0.3)":"rgba(200,169,110,0.2)"}`, color:"#9a7060", padding:"3px 10px", borderRadius:4, cursor:"pointer", fontSize:10, fontFamily:"Georgia,serif" }}>
                          🧹 {emptyProjectsCount} leere aufräumen
                        </button>
                      )}
                      <button onClick={() => setShowNewFolder(f => !f)} style={{ background:"transparent", border:`1px solid ${lightMode?"rgba(80,30,120,0.3)":"rgba(200,169,110,0.2)"}`, color:lightMode?"#2a0850":"#7a6040", padding:"3px 10px", borderRadius:4, cursor:"pointer", fontSize:10, fontFamily:"Georgia,serif" }}>+ Neu</button>
                    </div>
                  </div>

                  {showNewFolder && (
                    <div style={{ display:"flex", gap:8, marginBottom:10 }}>
                      <input placeholder="Projektname z.B. Dr. Lydia Hartmann" value={newFolderName} onChange={e => setNewFolderName(e.target.value)}
                        onKeyDown={e => e.key==="Enter" && createFolder()}
                        style={{ flex:1, padding:"7px 10px", background:"rgba(200,169,110,0.04)", border:`1px solid ${lightMode?"rgba(80,30,120,0.3)":"rgba(200,169,110,0.2)"}`, borderRadius:6, color:lightMode?"#2a0850":"#d4c4a0", fontFamily:"Georgia,serif", fontSize:12, outline:"none" }} />
                      <button onClick={createFolder} style={{ background:"rgba(200,169,110,0.12)", border:`1px solid ${gold}`, color:gold, padding:"7px 14px", borderRadius:6, cursor:"pointer", fontSize:12, fontFamily:"Georgia,serif" }}>✓</button>
                    </div>
                  )}

                  <div style={{ display:"flex", gap:6, flexWrap:"wrap", marginBottom:10 }}>
                    <button onClick={() => {
                      setWritingProjectId(null);
                      setWritingProjekt("");
                      setWritingHook("");
                      setWritingBemerkung("");
                      setSelectedTemplate(null);
                      setShowProjectList(false);
                    }}
                      style={{ padding:"5px 12px", borderRadius:5, border:`1px solid ${lightMode?"#c8a8e0":gold}`, background:lightMode?"rgba(200,168,224,0.18)":"rgba(200,169,110,0.18)", color:gold, cursor:"pointer", fontSize:11, fontFamily:"Georgia,serif", fontWeight:"bold" }}>
                      ✨ Start (neue Session)
                    </button>
                    <button onClick={() => { setSelectedFolder(null); setShowProjectList(true); }}
                      style={{ padding:"5px 12px", borderRadius:5, border:`1px solid ${!selectedFolder && showProjectList?(lightMode?"#c8a8e0":gold):"rgba(200,169,110,0.2)"}`, background:!selectedFolder && showProjectList?(lightMode?"rgba(200,168,224,0.18)":"rgba(200,169,110,0.12)"):"transparent", color:!selectedFolder && showProjectList?gold:"#7a6040", cursor:"pointer", fontSize:11, fontFamily:"Georgia,serif" }}>
                      Alle
                    </button>
                    {folders.map(f => (
                      <div key={f.id} style={{ display:"flex", alignItems:"center", gap:4 }}>
                        <button onClick={() => { setSelectedFolder(f.id); setShowProjectList(true); }}
                          style={{ padding:"5px 12px", borderRadius:5, border:`1px solid ${selectedFolder===f.id?(lightMode?"#c8a8e0":gold):"rgba(200,169,110,0.2)"}`, background:selectedFolder===f.id?(lightMode?"rgba(200,168,224,0.18)":"rgba(200,169,110,0.12)"):"transparent", color:selectedFolder===f.id?gold:"#7a6040", cursor:"pointer", fontSize:11, fontFamily:"Georgia,serif" }}>
                          📁 {f.name}
                        </button>
                        {selectedFolder===f.id && (
                          <button onClick={() => printFolder(f.id)} style={{ background:"transparent", border:"none", color:lightMode?"#2a0850":"#7a6040", cursor:"pointer", fontSize:12 }} title="Ganzes Projekt drucken">🖨️</button>
                        )}
                        <button onClick={() => deleteFolder(f.id)} style={{ background:"transparent", border:"none", color:"#4a3a2a", cursor:"pointer", fontSize:10 }}>✕</button>
                      </div>
                    ))}
                  </div>

                  {/* Sessions im gewählten Ordner — nur sichtbar wenn "Alle" oder ein Ordner aktiv gewählt wurde, NICHT bei "Start" */}
                  {showProjectList && (
                    <div style={{ maxHeight:280, overflowY:"auto" }}>
                      {savedProjects.filter(p => selectedFolder ? p.folder_id === selectedFolder : true).length === 0 && (
                        <div style={{ fontSize:11, color:lightMode?"#2a0850":"#5a4a34", fontStyle:"italic" }}>Noch keine Sessions hier.</div>
                      )}
                      {savedProjects.filter(p => selectedFolder ? p.folder_id === selectedFolder : true).map(proj => (
                        <div key={proj.id} style={{ display:"flex", alignItems:"center", gap:8, marginBottom:6, background:"rgba(200,169,110,0.04)", border:`1px solid ${lightMode?"rgba(80,30,120,0.3)":"rgba(200,169,110,0.15)"}`, borderRadius:7, padding:"8px 12px" }}>
                          <button onClick={() => loadProject(proj)} style={{ flex:1, background:"none", border:"none", color:gold, cursor:"pointer", fontSize:12, fontFamily:"Georgia,serif", textAlign:"left" }}>
                            ✍️ {proj.name}
                          </button>
                          <span style={{ fontSize:9, color:lightMode?"#2a0850":"#5a4a34" }}>{new Date(proj.updated_at).toLocaleString('de-DE', {day:'2-digit',month:'2-digit',year:'2-digit',hour:'2-digit',minute:'2-digit'})}</span>
                          <button onClick={() => deleteProject(proj.id)} style={{ background:"none", border:"none", color:"#5a3a2a", cursor:"pointer", fontSize:11 }}>✕</button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div style={{ borderTop:`1px solid ${lightMode?"rgba(80,30,120,0.3)":"rgba(200,169,110,0.1)"}`, paddingTop:16, marginBottom:14 }}>
                  <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:5 }}>
                    <div style={{ fontSize:11, color:lightMode?"#2a0850":"#9a8060" }}>Session-Name</div>
                  </div>
                  <input placeholder="z.B. Die Karten haben gesprochen… und ich schreibe es auf 😄" value={writingProjekt}
                    onChange={e => {
                      setWritingProjekt(e.target.value);
                      if (writingProjectId) saveWritingSession(writingNotes, e.target.value, writingBemerkung);
                    }}
                    style={{ width:"100%", padding:"10px 12px", background:"rgba(200,169,110,0.04)", border:`1px solid ${lightMode?"rgba(80,30,120,0.3)":"rgba(200,169,110,0.2)"}`, borderRadius:7, color:lightMode?"#2a0850":"#d4c4a0", fontFamily:"Georgia,serif", fontSize:13, outline:"none", boxSizing:"border-box" }} />
                  {selectedFolder && (
                    <div style={{ fontSize:10, color:lightMode?"#2a0850":"#7a6040", marginTop:6 }}>
                      📁 wird abgelegt in: {folders.find(f => f.id === selectedFolder)?.name || ""}
                    </div>
                  )}
                </div>
                <div style={{ marginBottom:24 }}>
                  <div style={{ fontSize:11, color:lightMode?"#2a0850":"#9a8060", marginBottom:5 }}>🎯 The Hook</div>
                  <textarea placeholder="Der Aufhänger, der die Leute reinzieht…" value={writingHook} onChange={e => setWritingHook(e.target.value)} rows={2}
                    style={{ width:"100%", padding:"10px 12px", background:"rgba(200,169,110,0.04)", border:`1px solid ${lightMode?"rgba(80,30,120,0.3)":"rgba(200,169,110,0.2)"}`, borderRadius:7, color:lightMode?"#2a0850":"#d4c4a0", fontFamily:"Georgia,serif", fontSize:13, outline:"none", boxSizing:"border-box", resize:"none", lineHeight:1.6 }} />
                </div>

                <div style={{ height:1, background:"linear-gradient(90deg, transparent, rgba(200,169,110,0.25), transparent)", margin:"0 0 20px" }} />

                <div style={{ marginBottom:24 }}>
                  <div style={{ fontSize:11, color:lightMode?"#2a0850":"#9a8060", marginBottom:5 }}>Bemerkungen</div>
                  <textarea placeholder="z.B. Szene 1 ~ Was noch geschah…" value={writingBemerkung} onChange={e => setWritingBemerkung(e.target.value)} rows={3}
                    style={{ width:"100%", padding:"10px 12px", background:"rgba(200,169,110,0.04)", border:`1px solid ${lightMode?"rgba(80,30,120,0.3)":"rgba(200,169,110,0.2)"}`, borderRadius:7, color:lightMode?"#2a0850":"#d4c4a0", fontFamily:"Georgia,serif", fontSize:13, outline:"none", boxSizing:"border-box", resize:"none", lineHeight:1.6 }} />
                </div>

                <div style={{ marginBottom:24 }}>
                  <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:8 }}>
                    <div style={{ fontSize:11, color:lightMode?"#2a0850":"#9a8060" }}>📋 Vorlage</div>
                  </div>
                  {textTemplates.length === 0 ? (
                    <div style={{ fontSize:11, color:lightMode?"#2a0850":"#5a4a34", fontStyle:"italic" }}>Noch keine Vorlagen gespeichert — die kommen nach dem Schreiben per "💾 Speichern unter" dazu.</div>
                  ) : (
                    <div style={{ display:"flex", gap:6, flexWrap:"wrap" }}>
                      <button onClick={() => setSelectedTemplate(null)}
                        style={{ padding:"5px 12px", borderRadius:5, border:`1px solid ${!selectedTemplate?(lightMode?"#c8a8e0":gold):"rgba(200,169,110,0.2)"}`, background:!selectedTemplate?(lightMode?"rgba(200,168,224,0.18)":"rgba(200,169,110,0.12)"):"transparent", color:!selectedTemplate?gold:"#7a6040", cursor:"pointer", fontSize:11, fontFamily:"Georgia,serif" }}>
                        Ohne Vorlage
                      </button>
                      {textTemplates.map(tpl => (
                        <div key={tpl.id} style={{ display:"flex", alignItems:"center", gap:4 }}>
                          <button onClick={() => setSelectedTemplate(tpl)}
                            style={{ padding:"5px 12px", borderRadius:5, border:`1px solid ${selectedTemplate?.id===tpl.id?(lightMode?"#c8a8e0":gold):"rgba(200,169,110,0.2)"}`, background:selectedTemplate?.id===tpl.id?(lightMode?"rgba(200,168,224,0.18)":"rgba(200,169,110,0.12)"):"transparent", color:selectedTemplate?.id===tpl.id?gold:"#7a6040", cursor:"pointer", fontSize:11, fontFamily:"Georgia,serif" }}>
                            📋 {tpl.name}
                          </button>
                          <button onClick={() => deleteTemplate(tpl.id)} style={{ background:"transparent", border:"none", color:"#4a3a2a", cursor:"pointer", fontSize:10 }}>✕</button>
                        </div>
                      ))}
                    </div>
                  )}
                  {selectedTemplate && (
                    <div style={{ marginTop:10, padding:"8px 10px", background:"rgba(200,169,110,0.04)", border:`1px solid ${lightMode?"rgba(80,30,120,0.3)":"rgba(200,169,110,0.15)"}`, borderRadius:6, fontSize:10, color:lightMode?"#2a0850":"#9a8060", lineHeight:1.6 }}>
                      <div style={{ color:gold, marginBottom:3 }}>Vorschau "{selectedTemplate.name}":</div>
                      {Object.entries(selectedTemplate.notes || {}).filter(([k,v]) => v && String(v).trim()).length === 0 ? (
                        <div style={{ fontStyle:"italic" }}>(noch keine Inhalte in dieser Vorlage)</div>
                      ) : (
                        Object.entries(selectedTemplate.notes || {}).filter(([k,v]) => v && String(v).trim()).map(([k,v]) => (
                          <div key={k}><strong>{TEMPLATE_FIELD_LABELS[k] || k}:</strong> {String(v).slice(0, 80)}{String(v).length > 80 ? "…" : ""}</div>
                        ))
                      )}
                    </div>
                  )}
                </div>

                <div style={{ display:"flex", justifyContent:"center", gap:10, flexWrap:"wrap" }}>
                  <button onClick={() => {
                    writingRandom();
                    setWritingMode("situation");
                    setMatrixFreeText({});
                    setWritingNotes(selectedTemplate ? {...(selectedTemplate.notes || {})} : {});
                    setWritingProjectId(null);
                    setWritingView("writing");
                  }} style={{ background:"rgba(200,169,110,0.12)", border:`1px solid ${gold}`, color:lightMode?"#2a0850":gold, padding:"10px 20px", borderRadius:6, cursor:"pointer", fontSize:13, fontFamily:"Georgia,serif", letterSpacing:1 }}>
                    🎲 Würfeln →
                  </button>
                  <button onClick={() => {
                    writingRandom();
                    setWritingMode("personen");
                    setMatrixFreeText({});
                    setWritingNotes(selectedTemplate ? {...(selectedTemplate.notes || {})} : {});
                    setWritingProjectId(null);
                    setWritingView("writing");
                  }} style={{ background:"rgba(200,169,110,0.12)", border:`1px solid ${gold}`, color:lightMode?"#2a0850":gold, padding:"10px 20px", borderRadius:6, cursor:"pointer", fontSize:13, fontFamily:"Georgia,serif", letterSpacing:1 }}>
                    👤 Personen →
                  </button>
                  <button onClick={() => {
                    setMatrixCards(Array(9).fill(null));
                    setSignifikator(null);
                    setIntroCard(null);
                    setOutroCard(null);
                    setWritingMode("situation");
                    setMatrixFreeText({});
                    setWritingNotes(selectedTemplate ? {...(selectedTemplate.notes || {})} : {});
                    setWritingProjectId(null);
                    setWritingView("picking");
                  }} style={{ background:"rgba(200,169,110,0.08)", border:`1px solid rgba(200,169,110,0.4)`, color:lightMode?"#2a0850":"#c8a96e", padding:"10px 20px", borderRadius:6, cursor:"pointer", fontSize:13, fontFamily:"Georgia,serif", letterSpacing:1 }}>
                    🃏 Karten wählen →
                  </button>
                </div>
              </div>
            )}

            {/* Karten-Picker für Writing */}
            {writingView === "picking" && (
              <div>
                <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:16 }}>
                  <button onClick={() => setWritingView("projekt")} style={{ background:"transparent", border:"none", color:lightMode?"#2a0850":"#5a4a34", cursor:"pointer", fontSize:11, fontFamily:"Georgia,serif", padding:0 }}>← zurück</button>
                  <div style={{ fontSize:11, color:lightMode?"#2a0850":"#7a6040", fontStyle:"italic" }}>Klicke eine Position — dann wähle die Karte</div>
                  <button onClick={() => { if(signifikator || matrixFreeText[4]) setWritingView("writing"); }}
                    disabled={!signifikator && !matrixFreeText[4]}
                    style={{ background:(signifikator||matrixFreeText[4])?(lightMode?"rgba(200,168,224,0.18)":"rgba(200,169,110,0.12)"):"transparent", border:`1px solid ${(signifikator||matrixFreeText[4])?(lightMode?"#c8a8e0":gold):"rgba(200,169,110,0.2)"}`, color:(signifikator||matrixFreeText[4])?gold:"#4a3a24", padding:"6px 16px", borderRadius:6, cursor:(signifikator||matrixFreeText[4])?"pointer":"default", fontSize:12, fontFamily:"Georgia,serif" }}>
                    Weiter →
                  </button>
                </div>

                {/* Intro — wie eine 10. Position, eigene Zeile vor der 3×3-Matrix */}
                <div onClick={() => {
                    const willActivate = activePos !== "intro";
                    setActivePos(willActivate ? "intro" : null);
                    if (willActivate) setPickerMode(matrixFreeText["intro"] ? "freitext" : "karte");
                  }}
                  style={{ border:`1.5px solid ${activePos==="intro"?(lightMode?"#c8a8e0":gold):(introCard||matrixFreeText["intro"])?(lightMode?"rgba(200,168,224,0.55)":"rgba(200,169,110,0.4)"):(lightMode?"rgba(200,168,224,0.35)":"rgba(200,169,110,0.15)")}`, borderRadius:8, padding:"8px 10px", marginBottom:8, cursor:"pointer", background:activePos==="intro"?(lightMode?"rgba(200,168,224,0.18)":"rgba(200,169,110,0.06)"):"rgba(200,169,110,0.02)", display:"flex", alignItems:"center", gap:8 }}>
                  <div style={{ fontSize:8, color:lightMode?"#2a0850":"#5a4a34", letterSpacing:1, textTransform:"uppercase", width:50, flexShrink:0 }}>🎬 Intro</div>
                  {introCard ? (<>
                    <span style={{ fontSize:18 }}>{SYMBOLS[introCard]}</span>
                    <span style={{ fontSize:10, color:lightMode?"#2a0850":gold }}>{CARDS[introCard].name}</span>
                  </>) : matrixFreeText["intro"] ? (
                    <span style={{ fontSize:10, color:lightMode?"#2a0850":gold, fontStyle:"italic" }}>✍️ {matrixFreeText["intro"].slice(0,30)}{matrixFreeText["intro"].length>30?"…":""}</span>
                  ) : <span style={{ fontSize:10, color:lightMode?"#2a0850":"#3a2a18" }}>+ optional eine Karte zuordnen</span>}
                </div>

                {/* 3×3 Grid */}
                <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:8, marginBottom:8 }}>
                  {[0,1,2,3,4,5,6,7,8].map(pos => {
                    const card = matrixCards ? matrixCards[pos] : null;
                    const freeText = matrixFreeText[pos];
                    const isCenter = pos === 4;
                    const labels = ["Gedanken","IST-Situation","Rat der Engel","Warnung","Signifikator","Nahe Zukunft","Ursache","Unbew. Zukunft","Ergebnis"];
                    const isActive = activePos === pos;
                    return (
                      <div key={pos} onClick={() => {
                        const willActivate = !isActive;
                        setActivePos(willActivate ? pos : null);
                        if (willActivate) setPickerMode(matrixFreeText[pos] ? "freitext" : "karte");
                      }}
                        style={{ border:`1.5px solid ${isActive?(lightMode?"#c8a8e0":gold):(card||freeText)?(lightMode?"rgba(200,168,224,0.55)":"rgba(200,169,110,0.4)"):(lightMode?"rgba(200,168,224,0.35)":"rgba(200,169,110,0.15)")}`, borderRadius:8, padding:"8px 6px", textAlign:"center", cursor:"pointer", background:isCenter?(lightMode?"rgba(200,168,224,0.20)":"rgba(200,169,110,0.08)"):isActive?(lightMode?"rgba(200,168,224,0.18)":"rgba(200,169,110,0.06)"):"rgba(200,169,110,0.02)", minHeight:80 }}>
                        <div style={{ fontSize:8, color:lightMode?"#2a0850":"#5a4a34", letterSpacing:1, textTransform:"uppercase", marginBottom:4 }}>{labels[pos]}</div>
                        {card ? (<>
                          <div style={{ fontSize:24 }}>{SYMBOLS[card]}</div>
                          <div style={{ fontSize:8, color:lightMode?"#2a0850":gold, marginTop:2 }}>{CARDS[card].name}</div>
                        </>) : freeText ? (
                          <div style={{ fontSize:10, color:lightMode?"#2a0850":gold, marginTop:10, lineHeight:1.3, wordBreak:"break-word" }}>✍️ {freeText.slice(0, 40)}{freeText.length > 40 ? "…" : ""}</div>
                        ) : <div style={{ fontSize:10, color:lightMode?"#2a0850":"#3a2a18", marginTop:8 }}>+</div>}
                      </div>
                    );
                  })}
                </div>

                {/* Outro — wie eine 11. Position, eigene Zeile nach der 3×3-Matrix */}
                <div onClick={() => {
                    const willActivate = activePos !== "outro";
                    setActivePos(willActivate ? "outro" : null);
                    if (willActivate) setPickerMode(matrixFreeText["outro"] ? "freitext" : "karte");
                  }}
                  style={{ border:`1.5px solid ${activePos==="outro"?(lightMode?"#c8a8e0":gold):(outroCard||matrixFreeText["outro"])?(lightMode?"rgba(200,168,224,0.55)":"rgba(200,169,110,0.4)"):(lightMode?"rgba(200,168,224,0.35)":"rgba(200,169,110,0.15)")}`, borderRadius:8, padding:"8px 10px", marginBottom:16, cursor:"pointer", background:activePos==="outro"?(lightMode?"rgba(200,168,224,0.18)":"rgba(200,169,110,0.06)"):"rgba(200,169,110,0.02)", display:"flex", alignItems:"center", gap:8 }}>
                  <div style={{ fontSize:8, color:lightMode?"#2a0850":"#5a4a34", letterSpacing:1, textTransform:"uppercase", width:50, flexShrink:0 }}>🎬 Outro</div>
                  {outroCard ? (<>
                    <span style={{ fontSize:18 }}>{SYMBOLS[outroCard]}</span>
                    <span style={{ fontSize:10, color:lightMode?"#2a0850":gold }}>{CARDS[outroCard].name}</span>
                  </>) : matrixFreeText["outro"] ? (
                    <span style={{ fontSize:10, color:lightMode?"#2a0850":gold, fontStyle:"italic" }}>✍️ {matrixFreeText["outro"].slice(0,30)}{matrixFreeText["outro"].length>30?"…":""}</span>
                  ) : <span style={{ fontSize:10, color:lightMode?"#2a0850":"#3a2a18" }}>+ optional eine Karte zuordnen</span>}
                </div>

                {/* Karten-Suche und Grid, oder freier Text */}
                {activePos !== null && (
                  <div>
                    <div style={{ display:"flex", gap:6, marginBottom:8 }}>
                      <button onClick={() => setPickerMode(m => m === "freitext" ? "karte" : "freitext")}
                        style={{ background: pickerMode==="freitext" ? "rgba(200,169,110,0.15)" : "transparent", border:`1px solid ${pickerMode==="freitext"?gold:"rgba(200,169,110,0.2)"}`, color: pickerMode==="freitext"?gold:"#7a6040", padding:"4px 10px", borderRadius:5, cursor:"pointer", fontSize:10, fontFamily:"Georgia,serif" }}>
                        {pickerMode === "freitext" ? "🃏 stattdessen Karte wählen" : "✍️ stattdessen eigenen Text eintragen"}
                      </button>
                      {(getCardForPos(activePos) || matrixFreeText[activePos]) && (
                        <button onClick={() => {
                          setCardForPos(activePos, null);
                          const newFree = {...matrixFreeText};
                          delete newFree[activePos];
                          setMatrixFreeText(newFree);
                          if (activePos === 4) setSignifikator(null);
                        }} style={{ background:"transparent", border:`1px solid ${lightMode?"rgba(80,30,120,0.3)":"rgba(200,169,110,0.2)"}`, color:lightMode?"#2a0850":"#7a6040", padding:"4px 10px", borderRadius:5, cursor:"pointer", fontSize:10, fontFamily:"Georgia,serif" }}>
                          ✕ leeren
                        </button>
                      )}
                    </div>

                    {pickerMode === "freitext" ? (
                      <div>
                        <textarea
                          placeholder="Eigener Begriff oder Thema für dieses Feld…"
                          value={matrixFreeText[activePos] || ""}
                          onChange={e => {
                            setMatrixFreeText({...matrixFreeText, [activePos]: e.target.value});
                            // Freitext und Karte schließen sich an dieser Position gegenseitig aus
                            if (getCardForPos(activePos)) {
                              setCardForPos(activePos, null);
                              if (activePos === 4) setSignifikator(null);
                            }
                          }}
                          rows={2}
                          style={{ width:"100%", padding:"8px 10px", background:"rgba(200,169,110,0.04)", border:`1px solid ${lightMode?"rgba(80,30,120,0.3)":"rgba(200,169,110,0.2)"}`, borderRadius:6, color:lightMode?"#2a0850":"#d4c4a0", fontFamily:"Georgia,serif", fontSize:12, outline:"none", boxSizing:"border-box", resize:"none" }} />
                        {activePos === 4 && (
                          <div style={{ fontSize:9, color:lightMode?"#2a0850":"#7a6040", marginTop:4, fontStyle:"italic" }}>Hinweis: Der Signifikator wird für Kombinationen gebraucht — bei freiem Text entfallen die Kartenkombinationen in den entsprechenden Feldern.</div>
                        )}
                      </div>
                    ) : (
                      <div>
                        <div style={{ marginBottom:8 }}>
                          <input placeholder="Karte suchen…" value={search} onChange={e => setSearch(e.target.value)}
                            style={{ width:"100%", padding:"6px 12px", background:"rgba(200,169,110,0.03)", border:`1px solid ${lightMode?"rgba(80,30,120,0.3)":"rgba(200,169,110,0.15)"}`, borderRadius:5, color:gold, fontFamily:"Georgia,serif", fontSize:11, outline:"none", boxSizing:"border-box" }} />
                        </div>
                        <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(90px,1fr))", gap:6, maxHeight:260, overflowY:"auto" }}>
                          {filteredCards().map(num => {
                            // "Schon verwendet"-Sperre gilt nur innerhalb der echten 3×3-Matrix —
                            // Intro/Outro dürfen auch eine dort bereits liegende Karte nochmal zeigen,
                            // schließlich sind das ja andere Erzähl-Ebenen (Rahmenhandlung vs. Matrix-Lektüre).
                            const alreadyUsed = typeof activePos === "number" && matrixCards && matrixCards.includes(num) && matrixCards[activePos] !== num;
                            return (
                              <button key={num} onClick={() => {
                                if (alreadyUsed) return;
                                setCardForPos(activePos, num);
                                if (activePos === 4) setSignifikator(num);
                                // Karte und Freitext schließen sich an dieser Position gegenseitig aus
                                if (matrixFreeText[activePos]) {
                                  const newFree = {...matrixFreeText};
                                  delete newFree[activePos];
                                  setMatrixFreeText(newFree);
                                }
                                setActivePos(null);
                              }}
                                style={{ background:"rgba(200,169,110,0.02)", border:`1px solid ${lightMode?"rgba(80,30,120,0.3)":"rgba(200,169,110,0.1)"}`, borderRadius:6, padding:"6px 4px", cursor:alreadyUsed?"default":"pointer", opacity:alreadyUsed?0.2:1, textAlign:"center", fontFamily:"Georgia,serif", color:lightMode?"#2a0850":"#9a8060", transition:"all 0.18s" }}
                                onMouseEnter={e => { if(alreadyUsed)return; e.currentTarget.style.borderColor=lightMode?"#c8a8e0":"rgba(200,169,110,0.35)"; e.currentTarget.style.color=gold; }}
                                onMouseLeave={e => { e.currentTarget.style.borderColor=lightMode?"rgba(80,30,120,0.3)":"rgba(200,169,110,0.1)"; e.currentTarget.style.color=lightMode?"#2a0850":"#9a8060"; }}>
                                <div style={{ fontSize:22 }}>{SYMBOLS[num]}</div>
                                <div style={{ fontSize:9, marginTop:3 }}>{num}. {CARDS[num].name}</div>
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {writingView === "writing" && (signifikator || matrixFreeText[4]) && matrixCards && (
              <div>
                <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:12 }}>
                  <button onClick={() => setWritingView("projekt")} style={{ background:"transparent", border:"none", color:lightMode?"#2a0850":"#5a4a34", cursor:"pointer", fontSize:11, fontFamily:"Georgia,serif", padding:0 }}>← zurück</button>
                  <div style={{ display:"flex", alignItems:"center", gap:10 }}>
                    {writingProjekt && <div style={{ fontSize:11, color:gold, fontStyle:"italic" }}>✍️ {writingProjekt}</div>}
                    <button onClick={() => { writingRandom(); }} style={{ background:"rgba(200,169,110,0.08)", border:`1px solid rgba(200,169,110,0.25)`, color:lightMode?"#2a0850":"#9a8060", padding:"4px 10px", borderRadius:5, cursor:"pointer", fontSize:11, fontFamily:"Georgia,serif" }}>🎲 neu</button>
                    <button onClick={saveProject} style={{ background:"rgba(200,169,110,0.12)", border:`1px solid ${gold}`, color:gold, padding:"4px 10px", borderRadius:5, cursor:"pointer", fontSize:11, fontFamily:"Georgia,serif" }}>💾 speichern</button>
                  </div>
                </div>

                {/* Responsive: Handy = untereinander, Desktop = nebeneinander */}
                <style>{`
                  .writing-layout { display: flex; flex-direction: row; gap: 20px; justify-content: center; }
                  .writing-matrix { flex: 1 1 0; min-width: 0; position: sticky; top: 20px; align-self: flex-start; }
                  .writing-notes  { flex: 1 1 0; min-width: 0; }
                  @media (max-width: 768px) {
                    .writing-layout { flex-direction: column; }
                    .writing-matrix { position: static; }
                  }
                `}</style>

                <div className="writing-layout">

                  {/* LINKS: Echte Matrix mit Deutungen */}
                  <div className="writing-matrix">
                    <div style={{ fontSize:9, letterSpacing:3, color:lightMode?"#2a0850":"#7a6040", textTransform:"uppercase", marginBottom:8 }}>
                      {signifikator ? (<>{SYMBOLS[signifikator]} {CARDS[signifikator].name}</>) : matrixFreeText[4] ? (<>✍️ {matrixFreeText[4]}</>) : null}
                      {" · "}{writingMode === "personen" ? "Personen-Matrix" : "Situations-Matrix"}
                    </div>
                    {writingHook && (
                      <div style={{ marginBottom:10, fontSize:10, color:lightMode?"#5a1080":"#c8a96e", fontStyle:"italic", lineHeight:1.5, borderLeft:"2px solid rgba(200,169,110,0.3)", paddingLeft:8 }}>
                        🎯 {writingHook}
                      </div>
                    )}
                    {writingBemerkung && (
                      <div style={{ marginBottom:10, fontSize:10, color:lightMode?"#2a0850":"#5a4a34", fontStyle:"italic", lineHeight:1.5, borderLeft:"2px solid rgba(200,169,110,0.15)", paddingLeft:8 }}>
                        {writingBemerkung}
                      </div>
                    )}
                    <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:6 }}>
                      {Array.from({length:9}, (_,pos) => {
                        const card = matrixCards[pos];
                        const isSignifikator = pos === 4;
                        const isKombi = KOMBI_POSITIONS.includes(pos);
                        const isActive = activeWritingPos === pos || (activeWritingPos !== null && isSignifikator && [1,5,7].includes(activeWritingPos));
                        const fixedText = getInspirationText(pos, isKombi ? 4 : null, isKombi ? card : null);
                        const posLabel = writingMode === "personen" ? (PERSONEN_POSITION_LABELS[String(pos)] || WRITING_POSITION_LABELS[pos]) : WRITING_POSITION_LABELS[pos];
                        return (
                          <div key={pos} style={{
                            background: lightMode ? (isActive ? "rgba(200,168,224,0.30)" : isSignifikator ? "rgba(200,168,224,0.22)" : isKombi ? "rgba(200,168,224,0.13)" : "rgba(200,168,224,0.07)") : (isActive ? "rgba(200,169,110,0.12)" : isSignifikator ? "rgba(200,169,110,0.08)" : isKombi ? "rgba(200,169,110,0.04)" : "rgba(200,169,110,0.02)"),
                            border: `1.5px solid ${lightMode ? (isActive ? "#c8a8e0" : isSignifikator ? "#c8a8e0" : isKombi ? "rgba(200,168,224,0.5)" : "rgba(200,168,224,0.3)") : (isActive ? gold : isSignifikator ? gold : isKombi ? "rgba(200,169,110,0.2)" : "rgba(200,169,110,0.1)")}`,
                            borderRadius:7, padding:"8px 6px",
                            transition:"all 0.2s"
                          }}>
                            <div style={{ fontSize:8, letterSpacing:2, color: lightMode ? "#2a0850" : (isKombi ? "rgba(212,184,120,0.8)" : "#8a7050"), textTransform:"uppercase", marginBottom:4 }}>
                              {posLabel}{isKombi ? " ✦" : ""}
                            </div>
                            {card && (
                              <div style={{ marginBottom:4, display:"flex", alignItems:"center", gap:3 }}>
                                <span style={{fontSize:12}}>{SYMBOLS[card]}</span>
                                <span style={{fontSize:7, color:lightMode?"#2a0850":gold}}>{CARDS[card].name}</span>
                              </div>
                            )}
                            {!card && matrixFreeText[pos] && (
                              <div style={{ marginBottom:4, fontSize:9, color:lightMode?"#2a0850":gold, fontStyle:"italic" }}>✍️ {matrixFreeText[pos]}</div>
                            )}
                            {isSignifikator && signifikator && <div style={{ fontSize:8, color:lightMode?"#2a0850":"#9a8a72", lineHeight:1.5 }}>{CARDS[signifikator].kw}</div>}
                            {fixedText && <div style={{ fontSize:9, color: lightMode?"#2a0850":(isKombi ? "#d8c8a0" : "#c0b090"), lineHeight:1.6 }}>{fixedText}</div>}
                            {!isSignifikator && !fixedText && (card || matrixFreeText[pos]) && <div style={{ fontSize:8, color:lightMode?"#2a0850":"#3a2a18" }}>–</div>}
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  {/* RECHTS: Writing-Positionen */}
                  <div className="writing-notes">
                    <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:4 }}>
                      <div style={{ fontSize:9, letterSpacing:3, color:lightMode?"#2a0850":"#7a6040", textTransform:"uppercase" }}>
                        ✍️ Deine Notizen {writingMode === "personen" ? "· 👤 Personen-Matrix" : ""}
                      </div>
                      <button onClick={() => setShowSaveTemplate(v => !v)}
                        style={{ background:"rgba(200,169,110,0.08)", border:`1px solid ${lightMode?"rgba(80,30,120,0.3)":"rgba(200,169,110,0.25)"}`, color:lightMode?"#2a0850":"#9a8060", padding:"3px 9px", borderRadius:5, cursor:"pointer", fontSize:10, fontFamily:"Georgia,serif" }}>
                        💾 Speichern unter
                      </button>
                    </div>
                    <div style={{ fontSize:9, marginBottom:8, color: writingSaveStatus==="saved" ? "#5a9a5a" : writingSaveStatus==="saving" ? "#9a8060" : writingSaveStatus==="error" ? "#c87a6a" : "transparent", minHeight:13 }}>
                      {writingSaveStatus==="saving" && "Speichert…"}
                      {writingSaveStatus==="saved" && (() => {
                        const p = savedProjects.find(pr => pr.id === writingProjectId);
                        const t = p && p.updated_at ? new Date(p.updated_at).toLocaleTimeString('de-DE', {hour:'2-digit', minute:'2-digit'}) : null;
                        return t ? `✓ Gespeichert um ${t} Uhr` : "✓ Gespeichert";
                      })()}
                      {writingSaveStatus==="error" && ("⚠ Nicht gespeichert" + (writingSaveError ? ": " + writingSaveError : " — bitte Internetverbindung prüfen"))}
                    </div>

                    {showSaveTemplate && (
                      <div style={{ marginBottom:10 }}>
                        {templateSaveError && (
                          <div style={{ fontSize:10, color:"#c87a6a", marginBottom:6, lineHeight:1.4 }}>
                            ⚠ Fehler beim Speichern: {templateSaveError}
                          </div>
                        )}
                        {textTemplates.length > 0 && (
                          <div style={{ marginBottom:8 }}>
                            <div style={{ fontSize:9, color:lightMode?"#2a0850":"#7a6040", marginBottom:4 }}>Bestehende Vorlage mit dem aktuellen Stand aktualisieren:</div>
                            <div style={{ display:"flex", gap:6, flexWrap:"wrap" }}>
                              {textTemplates.map(tpl => (
                                <button key={tpl.id} onClick={async () => { await updateTemplate(tpl); }}
                                  style={{ padding:"5px 10px", borderRadius:5, border:`1px solid ${gold}`, background:"rgba(200,169,110,0.08)", color:gold, cursor:"pointer", fontSize:10, fontFamily:"Georgia,serif" }}>
                                  💾 {tpl.name}
                                </button>
                              ))}
                            </div>
                          </div>
                        )}
                        <div style={{ fontSize:9, color:lightMode?"#2a0850":"#7a6040", marginBottom:4 }}>Oder als neue Vorlage anlegen:</div>
                        <div style={{ display:"flex", gap:8 }}>
                          <input placeholder="Name für eine NEUE Vorlage" value={newTemplateName} onChange={e => setNewTemplateName(e.target.value)}
                            onKeyDown={e => e.key==="Enter" && saveTemplate()}
                            style={{ flex:1, padding:"7px 10px", background:"rgba(200,169,110,0.04)", border:`1px solid ${lightMode?"rgba(80,30,120,0.3)":"rgba(200,169,110,0.2)"}`, borderRadius:6, color:lightMode?"#2a0850":"#d4c4a0", fontFamily:"Georgia,serif", fontSize:12, outline:"none" }} />
                          <button onClick={saveTemplate} style={{ background:"rgba(200,169,110,0.12)", border:`1px solid ${gold}`, color:gold, padding:"7px 14px", borderRadius:6, cursor:"pointer", fontSize:12, fontFamily:"Georgia,serif" }}>✓ Neu</button>
                        </div>
                      </div>
                    )}

                    {/* INTRO */}
                    <div style={{ marginBottom:10, background:"rgba(200,169,110,0.03)", border:`1px solid ${lightMode?"rgba(80,30,120,0.3)":"rgba(200,169,110,0.2)"}`, borderRadius:8, padding:"10px 12px 8px" }}>
                      <div onClick={() => setCollapsedFields(c => ({...c, intro: !c.intro}))} style={{ display:"flex", alignItems:"center", gap:6, marginBottom:4, cursor:"pointer" }}>
                        <span style={{ fontSize:11 }}>🎬</span>
                        <div style={{ fontSize:8, color:lightMode?"#2a0850":"#7a6040", letterSpacing:1, textTransform:"uppercase", flex:1 }}>Intro</div>
                        <span onClick={e => { e.stopPropagation(); setWritingView("picking"); setActivePos("intro"); setPickerMode(matrixFreeText["intro"] ? "freitext" : "karte"); }}
                          style={{ fontSize:10, color:gold, cursor:"pointer", display:"flex", alignItems:"center", gap:3 }}>
                          {introCard ? <>{SYMBOLS[introCard]} {CARDS[introCard].name}</> : "🃏 Karte zuordnen"}
                        </span>
                        {(writingNotes["intro"]||"").trim().split(/\s+/).filter(Boolean).length>=150 && <span style={{ fontSize:10, color:"#5a9a5a" }}>✓</span>}
                        <span style={{ fontSize:9, color:lightMode?"#2a0850":"#5a4a34" }}>{collapsedFields.intro ? "▸" : "▾"}</span>
                      </div>
                      {!collapsedFields.intro && (<>
                        <AutoTextarea
                          placeholder="Deine Begrüßung, Einstieg, Ankündigung…"
                          value={writingNotes["intro"] || ""}
                          onChange={e => { const n = {...writingNotes, intro: e.target.value}; setWritingNotes(n); saveWritingSession(n, writingProjekt, writingBemerkung); }}
                          onFocus={() => setActiveWritingPos(null)}
                          onBlur={() => setActiveWritingPos(null)}
                          minRows={2}
                          style={{ width:"100%", padding:"6px 8px", background:"rgba(200,169,110,0.04)", border:`1px solid ${lightMode?"rgba(80,30,120,0.3)":"rgba(200,169,110,0.15)"}`, borderRadius:5, color:lightMode?"#2a0850":"#d4c4a0", fontFamily:"Georgia,serif", fontSize:11, outline:"none", boxSizing:"border-box", lineHeight:1.5 }}
                        />
                        <div style={{ textAlign:"right", fontSize:8, color:(writingNotes["intro"]||"").trim().split(/\s+/).filter(Boolean).length>=150?"#5a9a5a":"#5a4a34", marginTop:1 }}>
                          {(writingNotes["intro"]||"").trim().split(/\s+/).filter(Boolean).length} / 150
                        </div>
                      </>)}
                    </div>

                    {[
                      {pos:4, icon:"📖", label:"Signifikator | Thema", comboWith: null},
                      {pos:0, icon:"💭", label:"Gedanken | Anfang", comboWith: null},
                      {pos:1, icon:"🎭", label:"IST-Situation | 1. Katastrophe", comboWith: 4},
                      {pos:2, icon:"👼", label:"Rat der Engel | 2. Katastrophe", comboWith: null},
                    ].map(({pos, icon, label, comboWith}) => {
                      const cardNum = matrixCards[pos];
                      const comboCardNum = comboWith !== null ? matrixCards[comboWith] : null;
                      const key = String(pos);
                      const text = writingNotes[key] || "";
                      const wordCount = text.trim().split(/\s+/).filter(Boolean).length;
                      const reached = wordCount >= 150;
                      return (
                        <div key={pos} style={{ marginBottom:10, background:"rgba(200,169,110,0.03)", border:`1px solid ${lightMode?"rgba(80,30,120,0.3)":"rgba(200,169,110,0.12)"}`, borderRadius:8, padding:"10px 12px 8px" }}>
                          <div onClick={() => setCollapsedFields(c => ({...c, [key]: !c[key]}))} style={{ display:"flex", alignItems:"center", gap:6, marginBottom:4, cursor:"pointer" }}>
                            <span style={{ fontSize:11 }}>{icon}</span>
                            <div style={{ fontSize:8, color:lightMode?"#2a0850":"#7a6040", letterSpacing:1, textTransform:"uppercase", flex:1 }}>{writingMode === "personen" ? (PERSONEN_POSITION_LABELS[key] || label) : label}</div>
                            {/* Karte(n) oder freier Text anzeigen */}
                            {cardNum && (<>
                              <span style={{ fontSize:14 }}>{SYMBOLS[cardNum]}</span>
                              <span style={{ fontSize:8, color:gold }}>{CARDS[cardNum].name}</span>
                            </>)}
                            {!cardNum && matrixFreeText[pos] && (
                              <span style={{ fontSize:9, color:gold, fontStyle:"italic" }}>✍️ {matrixFreeText[pos]}</span>
                            )}
                            {comboCardNum && (<>
                              <span style={{ fontSize:10, color:lightMode?"#2a0850":"#5a4a34" }}>+</span>
                              <span style={{ fontSize:14 }}>{SYMBOLS[comboCardNum]}</span>
                              <span style={{ fontSize:8, color:gold }}>{CARDS[comboCardNum].name}</span>
                            </>)}
                            {reached && <span style={{ fontSize:10, color:"#5a9a5a" }}>✓</span>}
                            <span style={{ fontSize:9, color:lightMode?"#2a0850":"#5a4a34" }}>{collapsedFields[key] ? "▸" : "▾"}</span>
                          </div>
                          {!collapsedFields[key] && (<>
                            {(() => {
                              const inspiration = getInspirationText(pos, comboWith, cardNum);
                              return inspiration ? (
                                <div style={{ fontSize:10, color:lightMode?"#2a0850":"#9a8060", fontStyle:"italic", lineHeight:1.5, marginBottom:6, padding:"6px 8px", background:"rgba(200,169,110,0.03)", borderRadius:5 }}>
                                  💡 {inspiration}
                                </div>
                              ) : null;
                            })()}
                            <AutoTextarea
                              placeholder={cardNum ? "Was zeigt " + CARDS[cardNum].name + (comboCardNum ? " + " + CARDS[comboCardNum].name : "") + " hier?" : matrixFreeText[pos] ? "Was bedeutet \"" + matrixFreeText[pos] + "\" hier?" : "Notizen…"}
                              value={text}
                              onChange={e => { const n = {...writingNotes, [key]: e.target.value}; setWritingNotes(n); saveWritingSession(n, writingProjekt, writingBemerkung); }}
                              onFocus={() => setActiveWritingPos(pos)}
                              onBlur={() => setActiveWritingPos(null)}
                              minRows={2}
                              style={{ width:"100%", padding:"6px 8px", background:"rgba(200,169,110,0.04)", border:`1px solid ${lightMode?"rgba(80,30,120,0.3)":"rgba(200,169,110,0.15)"}`, borderRadius:5, color:lightMode?"#2a0850":"#d4c4a0", fontFamily:"Georgia,serif", fontSize:11, outline:"none", boxSizing:"border-box", lineHeight:1.5 }}
                            />
                            <div style={{ textAlign:"right", fontSize:8, color:reached?"#5a9a5a":"#5a4a34", marginTop:1 }}>
                              {wordCount} / 150
                            </div>
                          </>)}
                        </div>
                      );
                    })}

                    {[
                      {pos:5, icon:"🔮", label:"Nahe Zukunft | Mittelteil", comboWith: 4},
                    ].map(({pos, icon, label, comboWith}) => {
                      const cardNum = matrixCards[pos];
                      const comboCardNum = comboWith !== null ? matrixCards[comboWith] : null;
                      const key = String(pos);
                      const text = writingNotes[key] || "";
                      const wordCount = text.trim().split(/\s+/).filter(Boolean).length;
                      const reached = wordCount >= 150;
                      return (
                        <div key={pos} style={{ marginBottom:10, background:"rgba(200,169,110,0.03)", border:`1px solid ${lightMode?"rgba(80,30,120,0.3)":"rgba(200,169,110,0.12)"}`, borderRadius:8, padding:"10px 12px 8px" }}>
                          <div onClick={() => setCollapsedFields(c => ({...c, [key]: !c[key]}))} style={{ display:"flex", alignItems:"center", gap:6, marginBottom:4, cursor:"pointer" }}>
                            <span style={{ fontSize:11 }}>{icon}</span>
                            <div style={{ fontSize:8, color:lightMode?"#2a0850":"#7a6040", letterSpacing:1, textTransform:"uppercase", flex:1 }}>{writingMode === "personen" ? (PERSONEN_POSITION_LABELS[key] || label) : label}</div>
                            {/* Karte(n) oder freier Text anzeigen */}
                            {cardNum && (<>
                              <span style={{ fontSize:14 }}>{SYMBOLS[cardNum]}</span>
                              <span style={{ fontSize:8, color:gold }}>{CARDS[cardNum].name}</span>
                            </>)}
                            {!cardNum && matrixFreeText[pos] && (
                              <span style={{ fontSize:9, color:gold, fontStyle:"italic" }}>✍️ {matrixFreeText[pos]}</span>
                            )}
                            {comboCardNum && (<>
                              <span style={{ fontSize:10, color:lightMode?"#2a0850":"#5a4a34" }}>+</span>
                              <span style={{ fontSize:14 }}>{SYMBOLS[comboCardNum]}</span>
                              <span style={{ fontSize:8, color:gold }}>{CARDS[comboCardNum].name}</span>
                            </>)}
                            {reached && <span style={{ fontSize:10, color:"#5a9a5a" }}>✓</span>}
                            <span style={{ fontSize:9, color:lightMode?"#2a0850":"#5a4a34" }}>{collapsedFields[key] ? "▸" : "▾"}</span>
                          </div>
                          {!collapsedFields[key] && (<>
                            {(() => {
                              const inspiration = getInspirationText(pos, comboWith, cardNum);
                              return inspiration ? (
                                <div style={{ fontSize:10, color:lightMode?"#2a0850":"#9a8060", fontStyle:"italic", lineHeight:1.5, marginBottom:6, padding:"6px 8px", background:"rgba(200,169,110,0.03)", borderRadius:5 }}>
                                  💡 {inspiration}
                                </div>
                              ) : null;
                            })()}
                            <AutoTextarea
                              placeholder={cardNum ? "Was zeigt " + CARDS[cardNum].name + (comboCardNum ? " + " + CARDS[comboCardNum].name : "") + " hier?" : matrixFreeText[pos] ? "Was bedeutet \"" + matrixFreeText[pos] + "\" hier?" : "Notizen…"}
                              value={text}
                              onChange={e => { const n = {...writingNotes, [key]: e.target.value}; setWritingNotes(n); saveWritingSession(n, writingProjekt, writingBemerkung); }}
                              onFocus={() => setActiveWritingPos(pos)}
                              onBlur={() => setActiveWritingPos(null)}
                              minRows={2}
                              style={{ width:"100%", padding:"6px 8px", background:"rgba(200,169,110,0.04)", border:`1px solid ${lightMode?"rgba(80,30,120,0.3)":"rgba(200,169,110,0.15)"}`, borderRadius:5, color:lightMode?"#2a0850":"#d4c4a0", fontFamily:"Georgia,serif", fontSize:11, outline:"none", boxSizing:"border-box", lineHeight:1.5 }}
                            />
                            <div style={{ textAlign:"right", fontSize:8, color:reached?"#5a9a5a":"#5a4a34", marginTop:1 }}>
                              {wordCount} / 150
                            </div>
                          </>)}
                        </div>
                      );
                    })}

                    {/* Freitext nach "Nahe Zukunft" */}
                    <div style={{ marginBottom:10, background:"rgba(200,169,110,0.03)", border:`1px solid ${lightMode?"rgba(80,30,120,0.3)":"rgba(200,169,110,0.12)"}`, borderRadius:8, padding:"10px 12px 8px" }}>
                      <div onClick={() => setCollapsedFields(c => ({...c, nachRatDerEngel: !c.nachRatDerEngel}))} style={{ display:"flex", alignItems:"center", gap:6, marginBottom:4, cursor:"pointer" }}>
                        <span style={{ fontSize:11 }}>💕</span>
                        <div style={{ fontSize:8, color:lightMode?"#2a0850":"#7a6040", letterSpacing:1, textTransform:"uppercase", flex:1 }}>Subplot</div>
                        {(writingNotes["nachRatDerEngel"]||"").trim().split(/\s+/).filter(Boolean).length>=150 && <span style={{ fontSize:10, color:"#5a9a5a" }}>✓</span>}
                        <span style={{ fontSize:9, color:lightMode?"#2a0850":"#5a4a34" }}>{collapsedFields.nachRatDerEngel ? "▸" : "▾"}</span>
                      </div>
                      {!collapsedFields.nachRatDerEngel && (<>
                        <AutoTextarea
                          placeholder="…"
                          value={writingNotes["nachRatDerEngel"] || ""}
                          onChange={e => { const n = {...writingNotes, nachRatDerEngel: e.target.value}; setWritingNotes(n); saveWritingSession(n, writingProjekt, writingBemerkung); }}
                          minRows={1}
                          style={{ width:"100%", padding:"6px 8px", background:"rgba(200,169,110,0.04)", border:`1px solid ${lightMode?"rgba(80,30,120,0.3)":"rgba(200,169,110,0.15)"}`, borderRadius:5, color:lightMode?"#2a0850":"#d4c4a0", fontFamily:"Georgia,serif", fontSize:11, outline:"none", boxSizing:"border-box", lineHeight:1.5 }}
                        />
                        <div style={{ textAlign:"right", fontSize:8, color:(writingNotes["nachRatDerEngel"]||"").trim().split(/\s+/).filter(Boolean).length>=150?"#5a9a5a":"#5a4a34", marginTop:1 }}>
                          {(writingNotes["nachRatDerEngel"]||"").trim().split(/\s+/).filter(Boolean).length} / 150
                        </div>
                      </>)}
                    </div>

                    {[
                      {pos:6, icon:"🦋", label:"Ursache | 3. Katastrophe", comboWith: null},
                      {pos:7, icon:"🌌", label:"Unbewusste Zukunft | Rückzug", comboWith: 4},
                      {pos:3, icon:"⚠️", label:"Warnung | Katharsis", comboWith: null},
                      {pos:8, icon:"🎯", label:"Ergebnis | Pay Off", comboWith: null},
                    ].map(({pos, icon, label, comboWith}) => {
                      const cardNum = matrixCards[pos];
                      const comboCardNum = comboWith !== null ? matrixCards[comboWith] : null;
                      const key = String(pos);
                      const text = writingNotes[key] || "";
                      const wordCount = text.trim().split(/\s+/).filter(Boolean).length;
                      const reached = wordCount >= 150;
                      return (
                        <div key={pos} style={{ marginBottom:10, background:"rgba(200,169,110,0.03)", border:`1px solid ${lightMode?"rgba(80,30,120,0.3)":"rgba(200,169,110,0.12)"}`, borderRadius:8, padding:"10px 12px 8px" }}>
                          <div onClick={() => setCollapsedFields(c => ({...c, [key]: !c[key]}))} style={{ display:"flex", alignItems:"center", gap:6, marginBottom:4, cursor:"pointer" }}>
                            <span style={{ fontSize:11 }}>{icon}</span>
                            <div style={{ fontSize:8, color:lightMode?"#2a0850":"#7a6040", letterSpacing:1, textTransform:"uppercase", flex:1 }}>{writingMode === "personen" ? (PERSONEN_POSITION_LABELS[key] || label) : label}</div>
                            {/* Karte(n) oder freier Text anzeigen */}
                            {cardNum && (<>
                              <span style={{ fontSize:14 }}>{SYMBOLS[cardNum]}</span>
                              <span style={{ fontSize:8, color:gold }}>{CARDS[cardNum].name}</span>
                            </>)}
                            {!cardNum && matrixFreeText[pos] && (
                              <span style={{ fontSize:9, color:gold, fontStyle:"italic" }}>✍️ {matrixFreeText[pos]}</span>
                            )}
                            {comboCardNum && (<>
                              <span style={{ fontSize:10, color:lightMode?"#2a0850":"#5a4a34" }}>+</span>
                              <span style={{ fontSize:14 }}>{SYMBOLS[comboCardNum]}</span>
                              <span style={{ fontSize:8, color:gold }}>{CARDS[comboCardNum].name}</span>
                            </>)}
                            {reached && <span style={{ fontSize:10, color:"#5a9a5a" }}>✓</span>}
                            <span style={{ fontSize:9, color:lightMode?"#2a0850":"#5a4a34" }}>{collapsedFields[key] ? "▸" : "▾"}</span>
                          </div>
                          {!collapsedFields[key] && (<>
                            {(() => {
                              const inspiration = getInspirationText(pos, comboWith, cardNum);
                              return inspiration ? (
                                <div style={{ fontSize:10, color:lightMode?"#2a0850":"#9a8060", fontStyle:"italic", lineHeight:1.5, marginBottom:6, padding:"6px 8px", background:"rgba(200,169,110,0.03)", borderRadius:5 }}>
                                  💡 {inspiration}
                                </div>
                              ) : null;
                            })()}
                            <AutoTextarea
                              placeholder={cardNum ? "Was zeigt " + CARDS[cardNum].name + (comboCardNum ? " + " + CARDS[comboCardNum].name : "") + " hier?" : matrixFreeText[pos] ? "Was bedeutet \"" + matrixFreeText[pos] + "\" hier?" : "Notizen…"}
                              value={text}
                              onChange={e => { const n = {...writingNotes, [key]: e.target.value}; setWritingNotes(n); saveWritingSession(n, writingProjekt, writingBemerkung); }}
                              onFocus={() => setActiveWritingPos(pos)}
                              onBlur={() => setActiveWritingPos(null)}
                              minRows={2}
                              style={{ width:"100%", padding:"6px 8px", background:"rgba(200,169,110,0.04)", border:`1px solid ${lightMode?"rgba(80,30,120,0.3)":"rgba(200,169,110,0.15)"}`, borderRadius:5, color:lightMode?"#2a0850":"#d4c4a0", fontFamily:"Georgia,serif", fontSize:11, outline:"none", boxSizing:"border-box", lineHeight:1.5 }}
                            />
                            <div style={{ textAlign:"right", fontSize:8, color:reached?"#5a9a5a":"#5a4a34", marginTop:1 }}>
                              {wordCount} / 150
                            </div>
                          </>)}
                        </div>
                      );
                    })}

                    {/* OUTRO */}
                    <div style={{ marginBottom:10, background:"rgba(200,169,110,0.03)", border:`1px solid ${lightMode?"rgba(80,30,120,0.3)":"rgba(200,169,110,0.2)"}`, borderRadius:8, padding:"10px 12px 8px" }}>
                      <div onClick={() => setCollapsedFields(c => ({...c, outro: !c.outro}))} style={{ display:"flex", alignItems:"center", gap:6, marginBottom:4, cursor:"pointer" }}>
                        <span style={{ fontSize:11 }}>🎬</span>
                        <div style={{ fontSize:8, color:lightMode?"#2a0850":"#7a6040", letterSpacing:1, textTransform:"uppercase", flex:1 }}>Outro</div>
                        <span onClick={e => { e.stopPropagation(); setWritingView("picking"); setActivePos("outro"); setPickerMode(matrixFreeText["outro"] ? "freitext" : "karte"); }}
                          style={{ fontSize:10, color:gold, cursor:"pointer", display:"flex", alignItems:"center", gap:3 }}>
                          {outroCard ? <>{SYMBOLS[outroCard]} {CARDS[outroCard].name}</> : "🃏 Karte zuordnen"}
                        </span>
                        {(writingNotes["outro"]||"").trim().split(/\s+/).filter(Boolean).length>=150 && <span style={{ fontSize:10, color:"#5a9a5a" }}>✓</span>}
                        <span style={{ fontSize:9, color:lightMode?"#2a0850":"#5a4a34" }}>{collapsedFields.outro ? "▸" : "▾"}</span>
                      </div>
                      {!collapsedFields.outro && (<>
                        <AutoTextarea
                          placeholder="Dein Abschluss, Call to Action, Verabschiedung…"
                          value={writingNotes["outro"] || ""}
                          onChange={e => { const n = {...writingNotes, outro: e.target.value}; setWritingNotes(n); saveWritingSession(n, writingProjekt, writingBemerkung); }}
                          onFocus={() => setActiveWritingPos(null)}
                          onBlur={() => setActiveWritingPos(null)}
                          minRows={2}
                          style={{ width:"100%", padding:"6px 8px", background:"rgba(200,169,110,0.04)", border:`1px solid ${lightMode?"rgba(80,30,120,0.3)":"rgba(200,169,110,0.15)"}`, borderRadius:5, color:lightMode?"#2a0850":"#d4c4a0", fontFamily:"Georgia,serif", fontSize:11, outline:"none", boxSizing:"border-box", lineHeight:1.5 }}
                        />
                        <div style={{ textAlign:"right", fontSize:8, color:(writingNotes["outro"]||"").trim().split(/\s+/).filter(Boolean).length>=150?"#5a9a5a":"#5a4a34", marginTop:1 }}>
                          {(writingNotes["outro"]||"").trim().split(/\s+/).filter(Boolean).length} / 150
                        </div>
                      </>)}
                    </div>

                    {/* Drucken */}
                    <div style={{ textAlign:"center", borderTop:`1px solid ${lightMode?"rgba(80,30,120,0.3)":"rgba(200,169,110,0.1)"}`, paddingTop:12, marginTop:4 }}>
                      <button onClick={() => {
                        const heute = new Date().toLocaleDateString('de-DE', {day:'2-digit', month:'2-digit', year:'numeric'});
                        const posLabelsBeforeEngel = [
                          {pos:4, label:"Signifikator | Thema"},
                          {pos:0, label:"Gedanken | Anfang"},
                          {pos:1, label:"IST-Situation | 1. Katastrophe"},
                          {pos:2, label:"Rat der Engel | 2. Katastrophe"},
                        ];
                        const posLabelNaheZukunft = {pos:5, label:"Nahe Zukunft | Mittelteil"};
                        const posLabelsAfterSubplot = [
                          {pos:6, label:"Ursache | 3. Katastrophe"},
                          {pos:7, label:"Unbewusste Zukunft | Rückzug"},
                          {pos:3, label:"Warnung | Katharsis"},
                          {pos:8, label:"Ergebnis | Pay Off"},
                        ];
                        const posLabels = [...posLabelsBeforeEngel, posLabelNaheZukunft, ...posLabelsAfterSubplot];
                        // Bei Personen-Modus die passenden Labels statt der Situations-Begriffe nehmen
                        const labelFor = (pos, fallback) => writingMode === "personen" ? (PERSONEN_POSITION_LABELS[String(pos)] || fallback) : fallback;
                        const nachIntroText = writingNotes["nachIntro"] || "";
                        const nachRatDerEngelText = writingNotes["nachRatDerEngel"] || "";
                        const vorOutroText = writingNotes["vorOutro"] || "";
                        const introText = writingNotes["intro"] || "";
                        const outroText = writingNotes["outro"] || "";
                        const introWc = introText.trim().split(/\s+/).filter(Boolean).length;
                        const outroWc = outroText.trim().split(/\s+/).filter(Boolean).length;
                        const nachIntroWc = nachIntroText.trim().split(/\s+/).filter(Boolean).length;
                        const nachRatDerEngelWc = nachRatDerEngelText.trim().split(/\s+/).filter(Boolean).length;
                        const vorOutroWc = vorOutroText.trim().split(/\s+/).filter(Boolean).length;
                        const posWc = posLabels.reduce((sum, {pos}) => {
                          const t = writingNotes[String(pos)] || "";
                          return sum + t.trim().split(/\s+/).filter(Boolean).length;
                        }, 0);
                        const totalWc = introWc + nachIntroWc + posWc + nachRatDerEngelWc + vorOutroWc + outroWc;

                        // 3×3-Matrix-Übersicht als HTML-Grid, in der gewohnten Anordnung (Signifikator in der Mitte)
                        const gridOrder = [0,1,2,3,4,5,6,7,8]; // Gedanken, IST, Rat der Engel, Warnung, Signifikator, Nahe Zukunft, Ursache, Unbew. Zukunft, Ergebnis
                        const matrixCellsHtml = gridOrder.map(pos => {
                          const cn = matrixCards[pos];
                          const ft = matrixFreeText[pos];
                          const isKombi = KOMBI_POSITIONS.includes(pos);
                          const lbl = labelFor(pos, WRITING_POSITION_LABELS[pos]);
                          const cardLine = cn ? (SYMBOLS[cn] + " " + CARDS[cn].name) : ft ? ("✍️ " + ft) : "–";
                          const insp = getInspirationText(pos, isKombi ? 4 : null, isKombi ? cn : null) || "";
                          return "<div class='cell" + (pos===4?" sig":"") + "'><div class='cell-lbl'>" + lbl + "</div><div class='cell-card'>" + cardLine + "</div>"
                            + (insp ? "<div class='cell-insp'>" + insp + "</div>" : "") + "</div>";
                        }).join("");
                        const matrixGridHtml = "<div class='matrix-title'>" + (writingMode === "personen" ? "👤 Personen-Matrix" : "⬛ Situations-Matrix") + "</div>"
                          + "<div class='grid'>" + matrixCellsHtml + "</div>";

                        const sigLine = signifikator ? (SYMBOLS[signifikator] + " " + CARDS[signifikator].name) : matrixFreeText[4] ? ("✍️ " + matrixFreeText[4]) : "–";

                        const html = "<html><head><title>" + (writingProjekt || "Writing Session") + "</title><style>"
                          + "body{font-family:Georgia,serif,'Apple Color Emoji','Segoe UI Emoji','Noto Color Emoji';max-width:700px;margin:40px auto;color:#2a1a0a;line-height:1.7}"
                          + "h1{color:#8a6020;border-bottom:2px solid #c8a96e;padding-bottom:8px}"
                          + ".meta{font-size:12px;color:#9a8060;margin-bottom:24px}"
                          + ".block{margin-bottom:20px;border-left:3px solid #c8a96e;padding-left:14px}"
                          + ".lbl{font-size:10px;color:#9a8060;letter-spacing:2px;text-transform:uppercase;margin-bottom:3px}"
                          + ".karte{font-size:13px;color:#8a6020;margin-bottom:5px}"
                          + ".insp{font-size:11px;color:#7a6040;font-style:italic;margin-bottom:5px}"
                          + ".txt{font-size:12px;color:#3a2a0a;white-space:pre-wrap}"
                          + ".cnt{font-size:9px;color:#9a8060;margin-top:3px}"
                          + ".total{margin-top:32px;padding-top:12px;border-top:2px solid #c8a96e;font-size:11px;color:#8a6020;text-align:right;letter-spacing:1px}"
                          + ".matrix-title{font-size:11px;color:#9a8060;letter-spacing:2px;text-transform:uppercase;margin:28px 0 8px}"
                          + ".grid{display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;margin-bottom:10px}"
                          + ".cell{border:1px solid #d8c8a0;border-radius:6px;padding:8px;background:#fbf8f0}"
                          + ".cell.sig{background:#f3e8cc;border-color:#c8a96e}"
                          + ".cell-lbl{font-size:8px;letter-spacing:1px;text-transform:uppercase;color:#9a8060;margin-bottom:3px}"
                          + ".cell-card{font-size:11px;color:#8a6020;margin-bottom:3px}"
                          + ".cell-insp{font-size:9px;color:#5a4a34;line-height:1.4}"
                          + "</style></head><body>"
                          + "<h1>✍️ " + (writingProjekt || "Ohne Titel") + "</h1>"
                          + "<div class='meta'>"
                          + (writingHook ? "🎯 " + writingHook + "<br>" : "")
                          + (writingBemerkung ? writingBemerkung + "<br>" : "")
                          + "Signifikator: " + sigLine
                          + "<br>" + heute + "</div>"
                          + matrixGridHtml
                          + (introText ? "<div class='block'><div class='lbl'>🎬 Intro" + (introCard ? " · " + SYMBOLS[introCard] + " " + CARDS[introCard].name : "") + "</div><div class='txt'>" + introText + "</div><div class='cnt'>" + introWc + " Wörter</div></div>" : "")
                          + (nachIntroText ? "<div class='block'><div class='lbl'>💥 Teaser</div><div class='txt'>" + nachIntroText + "</div><div class='cnt'>" + nachIntroWc + " Wörter</div></div>" : "")
                          + posLabelsBeforeEngel.map(({pos, label}) => {
                              const cn = matrixCards[pos];
                              const ft = matrixFreeText[pos];
                              const t = writingNotes[String(pos)] || "";
                              if (!t) return "";
                              const wc = t.trim().split(/\s+/).filter(Boolean).length;
                              const isKombi = KOMBI_POSITIONS.includes(pos);
                              const insp = getInspirationText(pos, isKombi ? 4 : null, isKombi ? cn : null) || "";
                              const cardLine = cn ? (SYMBOLS[cn] + " " + CARDS[cn].name) : ft ? ("✍️ " + ft) : "–";
                              return "<div class='block'><div class='lbl'>" + labelFor(pos, label) + "</div><div class='karte'>" + cardLine + "</div>" + (insp ? "<div class='insp'>💡 " + insp + "</div>" : "") + "<div class='txt'>" + t + "</div><div class='cnt'>" + wc + " Wörter</div></div>";
                            }).join("")
                          + [posLabelNaheZukunft].map(({pos, label}) => {
                              const cn = matrixCards[pos];
                              const ft = matrixFreeText[pos];
                              const t = writingNotes[String(pos)] || "";
                              if (!t) return "";
                              const wc = t.trim().split(/\s+/).filter(Boolean).length;
                              const isKombi = KOMBI_POSITIONS.includes(pos);
                              const insp = getInspirationText(pos, isKombi ? 4 : null, isKombi ? cn : null) || "";
                              const cardLine = cn ? (SYMBOLS[cn] + " " + CARDS[cn].name) : ft ? ("✍️ " + ft) : "–";
                              return "<div class='block'><div class='lbl'>" + labelFor(pos, label) + "</div><div class='karte'>" + cardLine + "</div>" + (insp ? "<div class='insp'>💡 " + insp + "</div>" : "") + "<div class='txt'>" + t + "</div><div class='cnt'>" + wc + " Wörter</div></div>";
                            }).join("")
                          + (nachRatDerEngelText ? "<div class='block'><div class='lbl'>💕 Subplot</div><div class='txt'>" + nachRatDerEngelText + "</div><div class='cnt'>" + nachRatDerEngelWc + " Wörter</div></div>" : "")
                          + posLabelsAfterSubplot.map(({pos, label}) => {
                              const cn = matrixCards[pos];
                              const ft = matrixFreeText[pos];
                              const t = writingNotes[String(pos)] || "";
                              if (!t) return "";
                              const wc = t.trim().split(/\s+/).filter(Boolean).length;
                              const isKombi = KOMBI_POSITIONS.includes(pos);
                              const insp = getInspirationText(pos, isKombi ? 4 : null, isKombi ? cn : null) || "";
                              const cardLine = cn ? (SYMBOLS[cn] + " " + CARDS[cn].name) : ft ? ("✍️ " + ft) : "–";
                              return "<div class='block'><div class='lbl'>" + labelFor(pos, label) + "</div><div class='karte'>" + cardLine + "</div>" + (insp ? "<div class='insp'>💡 " + insp + "</div>" : "") + "<div class='txt'>" + t + "</div><div class='cnt'>" + wc + " Wörter</div></div>";
                            }).join("")
                          + (vorOutroText ? "<div class='block'><div class='lbl'>💥 Teaser-Auflösung</div><div class='txt'>" + vorOutroText + "</div><div class='cnt'>" + vorOutroWc + " Wörter</div></div>" : "")
                          + (outroText ? "<div class='block'><div class='lbl'>🎬 Outro" + (outroCard ? " · " + SYMBOLS[outroCard] + " " + CARDS[outroCard].name : "") + "</div><div class='txt'>" + outroText + "</div><div class='cnt'>" + outroWc + " Wörter</div></div>" : "")
                          + "<div class='total'>✦ Gesamt: " + totalWc + " Wörter</div>"
                          + "</body></html>";
                        const w = window.open("","_blank");
                        w.document.write(html);
                        w.document.close();
                        w.print();
                      }} style={{ background:"transparent", border:`1px solid ${lightMode?"rgba(80,30,120,0.3)":"rgba(200,169,110,0.25)"}`, color:lightMode?"#2a0850":"#7a6040", padding:"8px 20px", borderRadius:6, cursor:"pointer", fontSize:12, fontFamily:"Georgia,serif", letterSpacing:1 }}>
                        🖨️ Session drucken
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ── ZAUBERZETTEL: Brief verbrennen ── */}
        {view === "tagebuch" && dailyMode === "manifest" && (
          <div style={{ paddingBottom:40, maxWidth:560, margin:"0 auto" }}>
            <style>{`
              @keyframes zettelEmber {
                0% { transform: translateY(0) translateX(0) scale(1); opacity:0; }
                12% { opacity:1; }
                100% { transform: translateY(-180px) translateX(var(--drift,0px)) scale(0.15); opacity:0; }
              }
              @keyframes zettelPaperBurn {
                0% { clip-path: inset(0 0 0% 0); }
                100% { clip-path: inset(0 0 103% 0); }
              }
              @keyframes zettelFireLine {
                0% { bottom:-4%; opacity:0; }
                7% { opacity:1; }
                93% { opacity:1; }
                100% { bottom:101%; opacity:0; }
              }
              @keyframes zettelFlicker {
                0%,100% { opacity:0.82; filter:blur(1px) brightness(1); }
                50% { opacity:1; filter:blur(1.5px) brightness(1.35); }
              }
              @keyframes zettelFlame {
                0% { transform: scaleY(0.85) scaleX(1) translateY(0); opacity:0.65; }
                100% { transform: scaleY(1.3) scaleX(0.8) translateY(-7px); opacity:1; }
              }
              .zettel-ink::placeholder { color: rgba(90,60,30,0.42); font-style:normal; }
            `}</style>

            {/* Kopf */}
            <div style={{ textAlign:"center", marginBottom:18 }}>
              <div style={{ fontSize:42, marginBottom:8 }}>🕯️</div>
              <div style={{ fontSize:19, color:lightMode?"#5a1080":gold, fontFamily:"Georgia,serif", letterSpacing:1, marginBottom:8 }}>Zauberzettel</div>
              <div style={{ fontSize:12.5, lineHeight:1.8, maxWidth:400, margin:"0 auto", fontStyle:"italic", color:lightMode?"#5a3a6a":"#9a8060" }}>
                Schreib auf, was sich erfüllen soll — jeder Wunsch eine Zeile.<br/>
                Dann verbrenne den Zettel und übergib ihn den himmlischen Mächten zur Bearbeitung. Wenn sich das Siegel öffnet, kannst du nachschauen.
              </div>
            </div>

            {/* Der Zettel — gealtertes Notizpapier wie im Design (Caveat-Handschrift) */}
            {!zettelBurning && (
              <div style={{ position:"relative", transform:"rotate(-0.9deg)", marginBottom:18 }}>
                <div style={{ position:"relative", borderRadius:"5px 8px 6px 7px", padding:"30px 28px 26px", overflow:"hidden", aspectRatio:"900 / 1440", display:"flex", flexDirection:"column",
                  background:"radial-gradient(120% 95% at 28% 18%, rgba(255,250,235,0.18), rgba(120,92,52,0) 42%), radial-gradient(58% 46% at 76% 66%, rgba(146,104,56,0.26), transparent 62%), radial-gradient(42% 30% at 18% 82%, rgba(112,80,42,0.30), transparent 60%), radial-gradient(30% 24% at 84% 22%, rgba(120,86,46,0.22), transparent 60%), linear-gradient(176deg, #ecdcb6 0%, #e1cd9f 46%, #d3bb88 100%)",
                  boxShadow:"0 10px 30px rgba(0,0,0,0.4), inset 0 0 44px rgba(86,58,26,0.34), inset 0 -22px 50px rgba(70,44,18,0.22)" }}>
                  <div style={{ position:"absolute", inset:0, backgroundImage: zettelGrain, backgroundSize:"160px 160px", opacity:0.07, mixBlendMode:"multiply", pointerEvents:"none" }}/>
                  <div style={{ position:"relative", fontFamily:"'Caveat', cursive", color:"#43301c" }}>
                    <div style={{ fontSize:16, opacity:0.6, letterSpacing:"0.04em" }}>Vollmond&nbsp;✦&nbsp;Neumond&nbsp;✦&nbsp;Zaubermond</div>
                    <div style={{ fontSize:34, fontWeight:700, lineHeight:1.0, marginTop:2, marginBottom:2 }}>Was ich mir wünsche</div>
                    <div style={{ width:170, height:3, marginBottom:16, transform:"rotate(-0.7deg)", background:"linear-gradient(90deg, rgba(67,48,28,0.85), rgba(67,48,28,0.2))", borderRadius:3 }} />
                    {zettelItems.map((it, i) => (
                      <div key={i} style={{ display:"flex", alignItems:"center", gap:10, marginBottom:6 }}>
                        <button onClick={()=>toggleZettelDone(i)} style={{ background:"none", border:"none", cursor:"pointer", fontSize:20, padding:0, lineHeight:1, color: it.done?"#4a6a2a":"#6a4a24" }}>{it.done?"✓":"○"}</button>
                        <input
                          className="zettel-ink"
                          ref={el => { zettelInputRefs.current[i] = el; }}
                          value={it.text}
                          onChange={e=>setZettelText(i, e.target.value)}
                          onKeyDown={e=>zettelKeyDown(e, i)}
                          placeholder={i===0 ? "Ich finde die passende Wohnung…" : "noch ein Wunsch…"}
                          style={{ flex:1, background:"transparent", border:"none", borderBottom:"1px solid rgba(96,64,28,0.22)", color:"#3a2410", fontFamily:"'Caveat', cursive", fontSize:22, lineHeight:1.2, padding:"2px 2px", outline:"none", textDecoration: it.done?"line-through":"none", opacity: it.done?0.55:1 }}
                        />
                        {zettelItems.length>1 && (
                          <button onClick={()=>removeZettelItem(i)} title="entfernen" style={{ background:"none", border:"none", cursor:"pointer", fontSize:15, color:"#9a5238", padding:"0 2px" }}>✕</button>
                        )}
                      </div>
                    ))}
                    <div style={{ fontSize:16, color:"#8a6a40", marginTop:8, paddingLeft:30, opacity:0.8 }}>↵ Enter für den nächsten Wunsch</div>
                  </div>
                </div>
              </div>
            )}

            {/* Brennender Zettel — freigestellt; Kante läuft jetzt über Canvas (GPU) */}
            {zettelBurning && (
              <div style={{ marginBottom:18 }}>
                <ZettelBurn items={zettelBurnSnapshot} showWishes={ZETTEL_SHOW_WISHES} onDone={handleBurnDone} />
                <div style={{ textAlign:"center", marginTop:16, fontSize:13, fontStyle:"italic", color:lightMode?"#7a3a9a":gold, fontFamily:"Georgia,serif" }}>✨ Emanuel nimmt deine Wünsche entgegen…</div>
              </div>
            )}

            {/* Versiegelungs-Dauer wählen (erscheint, sobald ein Wunsch dasteht) */}
            {!zettelBurning && zettelItems.some(it=>it.text.trim()) && (
              <div style={{ marginBottom:14 }}>
                <div style={{ textAlign:"center", fontSize:11, color:lightMode?"#5a1080":"#9a8060", fontStyle:"italic", marginBottom:8 }}>Wie lange darf dein Wunsch durchs Universum reisen?</div>
                <div style={{ display:"flex", gap:8 }}>
                  {ZETTEL_DURATIONS.map(d => {
                    const active = zettelDuration === d.key;
                    return (
                      <button key={d.key} onClick={()=>setZettelDuration(d.key)}
                        style={{ flex:1, padding:"9px 0", borderRadius:8, cursor:"pointer", fontFamily:"Georgia,serif", fontSize:12, letterSpacing:0.5,
                          background: active ? (lightMode?"#c8a8e0":"linear-gradient(135deg,#7a3a9a,#a85ac8)") : (lightMode?"rgba(122,58,154,0.06)":"rgba(200,169,110,0.05)"),
                          border:`1px solid ${active ? (lightMode?"#c8a8e0":gold) : (lightMode?"rgba(122,58,154,0.3)":"rgba(200,169,110,0.2)")}`,
                          color: active ? (lightMode?"#2a0850":"#fff") : (lightMode?"#5a1080":"#9a8060") }}>
                        {d.label}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Verbrennen-Knopf */}
            {!zettelBurning && (
              <button onClick={verbrenneZettel} disabled={!zettelItems.some(it=>it.text.trim())} style={{ display:"block", width:"100%", padding:"13px", background: zettelItems.some(it=>it.text.trim()) ? "linear-gradient(135deg,#c8551a,#e87a2a)" : (lightMode?"rgba(122,58,154,0.12)":"rgba(200,169,110,0.08)"), border:"none", borderRadius:10, color: zettelItems.some(it=>it.text.trim())?"#fff":(lightMode?"#9a7aaa":"#6a5a44"), fontFamily:"Georgia,serif", fontSize:15, letterSpacing:1, cursor: zettelItems.some(it=>it.text.trim())?"pointer":"default", marginBottom:30, boxShadow: zettelItems.some(it=>it.text.trim())?"0 4px 20px rgba(220,90,20,0.35)":"none" }}>🔥 Zettel verbrennen</button>
            )}

            {/* ── ARCHIV ── */}
            {zettelArchiv.length>0 && (
              <div>
                <div style={{ textAlign:"center", fontSize:10, letterSpacing:3, textTransform:"uppercase", color:lightMode?"#5a1080":"#7a6040", marginBottom:14 }}>📜 Dein Archiv</div>
                {zettelArchiv.map((entry, ei) => {
                  const unlock = new Date(entry.unlock_at);
                  const now = new Date();
                  const locked = !ZETTEL_UNLOCK_ALL && unlock > now;
                  const burnedStr = new Date(entry.burned_at).toLocaleDateString('de-DE',{day:'2-digit',month:'long',year:'numeric'});
                  const tageRest = Math.ceil((unlock - now)/(1000*60*60*24));
                  const erfuellt = (entry.items||[]).filter(it=>it.done).length;
                  return (
                    <div key={entry.id||ei} style={{ background:lightMode?"rgba(100,50,140,0.04)":"rgba(200,169,110,0.03)", border:`1px solid ${lightMode?"rgba(122,58,154,0.3)":"rgba(200,169,110,0.18)"}`, borderRadius:10, padding:"14px 16px", marginBottom:12 }}>
                      {locked ? (
                        <div style={{ textAlign:"center", padding:"6px 0" }}>
                          <div style={{ fontSize:30, marginBottom:6 }}>🔒</div>
                          <div style={{ fontSize:13, color:lightMode?"#5a1080":gold, fontFamily:"Georgia,serif", marginBottom:4 }}>Versiegelt für {zettelLockLabel(entry.burned_at, entry.unlock_at)}</div>
                          <div style={{ fontSize:11, color:lightMode?"#5a3a6a":"#9a8060", fontStyle:"italic", lineHeight:1.6 }}>
                            {(entry.items||[]).length} {(entry.items||[]).length===1?"Wunsch reist":"Wünsche reisen"} gerade durchs Universum.<br/>
                            Öffnet sich in {tageRest} {tageRest===1?"Tag":"Tagen"} — am {unlock.toLocaleDateString('de-DE',{day:'2-digit',month:'long',year:'numeric'})}.
                          </div>
                        </div>
                      ) : (
                        <div>
                          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"baseline", marginBottom:10 }}>
                            <span style={{ fontSize:11, color:lightMode?"#5a1080":gold, fontFamily:"Georgia,serif" }}>🕯️ verbrannt am {burnedStr}</span>
                            <span style={{ fontSize:10, color:"#5a9a5a" }}>{erfuellt}/{(entry.items||[]).length} erfüllt ✨</span>
                          </div>
                          {(entry.items||[]).map((it, ii) => (
                            <div key={ii} style={{ display:"flex", alignItems:"center", gap:8, marginBottom:6, padding:"3px 6px", borderRadius:4, background: it.done?"rgba(90,154,90,0.08)":"transparent" }}>
                              <button onClick={()=>toggleArchivItem(ei, ii)} style={{ background:"none", border:"none", cursor:"pointer", fontSize:15, padding:0, color: it.done?"#5a9a5a":(lightMode?"#7a3a9a":"#9a8060") }}>{it.done?"☑️":"☐"}</button>
                              <span style={{ flex:1, fontSize:12.5, fontFamily:"Georgia,serif", color: it.done?(lightMode?"#3a6a3a":"#5a7a5a"):(lightMode?"#2a0850":"#9a8060"), textDecoration: it.done?"line-through":"none" }}>{it.text}</span>
                              <button onClick={()=>deleteArchivItem(ei, ii)} title="Diesen Wunsch löschen" style={{ background:"none", border:"none", cursor:"pointer", fontSize:13, padding:"0 2px", opacity: it.done?0.85:0.4, color:lightMode?"#a05a5a":"#9a7060" }}>🗑</button>
                            </div>
                          ))}
                          {(entry.items||[]).some(it=>!it.done) && (
                            <div style={{ marginTop:10, paddingTop:10, borderTop:`1px dashed ${lightMode?"rgba(122,58,154,0.25)":"rgba(200,169,110,0.18)"}` }}>
                              <div style={{ fontSize:10.5, color:lightMode?"#7a3a9a":"#9a8060", fontStyle:"italic", marginBottom:6 }}>Noch offen? Schick sie nochmal auf die Reise — du wählst, wie lange:</div>
                              <div style={{ display:"flex", gap:6 }}>
                                {ZETTEL_DURATIONS.map(d => (
                                  <button key={d.key} onClick={()=>reSealEntry(ei, d.key)}
                                    style={{ flex:1, padding:"6px 0", borderRadius:6, cursor:"pointer", fontFamily:"Georgia,serif", fontSize:11,
                                      background:lightMode?"#c8a8e0":"rgba(200,169,110,0.05)",
                                      border:`1px solid ${lightMode?"#c8a8e0":"rgba(200,169,110,0.25)"}`,
                                      color:lightMode?"#2a0850":gold }}>
                                    🔒 {d.label}
                                  </button>
                                ))}
                              </div>
                            </div>
                          )}
                          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginTop:8, gap:8 }}>
                            <span style={{ fontSize:10, color:lightMode?"#8a6a9a":"#6a5040", fontStyle:"italic" }}>Hake ab, was sich erfüllt hat — und lösche es, wenn du magst. 💛</span>
                            <button onClick={()=>{ if (window.confirm("Diesen ganzen Eintrag aus dem Archiv löschen?")) deleteArchivEntry(ei); }} style={{ background:"none", border:`1px solid ${lightMode?"rgba(160,90,90,0.3)":"rgba(154,112,96,0.3)"}`, borderRadius:6, cursor:"pointer", fontSize:10, padding:"3px 8px", color:lightMode?"#a05a5a":"#9a7060", whiteSpace:"nowrap" }}>Eintrag löschen</button>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* ── QUEST (Platzhalter) ── */}
        {view === "tagebuch" && dailyMode === "quest" && (
          <div style={{ paddingBottom:30, minHeight:220, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", textAlign:"center" }}>
            <div style={{ fontSize:40, marginBottom:14 }}>🎯</div>
            <div style={{ fontSize:10, letterSpacing:4, color:lightMode?"#2a0850":"#7a6040", textTransform:"uppercase", marginBottom:12 }}>Quest</div>
            <div style={{ fontSize:14, color:lightMode?"#2a0850":"#d4c4a0", lineHeight:1.8, fontStyle:"italic", maxWidth:420, margin:"0 auto" }}>
              Diese Abteilung wird gerade neu gedacht.<br/>Bald findest du hier etwas Frisches. ✨
            </div>
          </div>
        )}

        {view === "cards" && (
          <div>
            {cardDetail ? (
              <div style={{ background:"rgba(200,169,110,0.02)", border:`1px solid ${lightMode?"rgba(80,30,120,0.3)":"rgba(200,169,110,0.15)"}`, borderRadius:10, padding:22 }}>
                <button onClick={() => setCardDetail(null)} style={{ background:"transparent", border:"none", color:lightMode?"#2a0850":"#7a6040", cursor:"pointer", fontSize:11, fontFamily:"Georgia,serif", marginBottom:12, padding:0 }}>← Übersicht</button>
                <div style={{ textAlign:"center", marginBottom:16 }}>
                  <div style={{ fontSize:42 }}>{SYMBOLS[cardDetail]}</div>
                  <h2 style={{ color:gold, fontWeight:"normal", margin:"7px 0 4px", fontSize:19 }}>{cardDetail}. {CARDS[cardDetail].name}</h2>
                  <div style={{ fontSize:11, color:"#6a5a44", maxWidth:360, margin:"0 auto", lineHeight:1.6 }}>{CARDS[cardDetail].kw}</div>
                </div>
                {CARD_INTROS[String(cardDetail)] && (
                  <div style={{ marginBottom:20 }}>
                    <div style={{ fontSize:9, letterSpacing:4, color:lightMode?"#2a0850":"#7a6040", marginBottom:10, textTransform:"uppercase" }}>Über diese Karte</div>
                    <div style={{ fontSize:13, color:lightMode?"#2a0850":"#c0b090", lineHeight:1.8, whiteSpace:"pre-line", borderLeft:"2px solid rgba(200,169,110,0.2)", paddingLeft:14 }}>
                      {CARD_INTROS[String(cardDetail)]}
                    </div>
                    <div style={{ borderTop:`1px solid ${lightMode?"rgba(80,30,120,0.3)":"rgba(200,169,110,0.1)"}`, marginTop:16, paddingTop:16 }}/>
                  </div>
                )}
                <div style={{ marginTop:8 }}>
                  {/* Akkordeon-Header Helper */}
                  {[
                    { key:"2er", label:"🃏 2er Kombinationen" },
                    { key:"3er", label:"🔺 3er Kombinationen" },
                    { key:"4er", label:"🔷 4er Kombinationen" },
                  ].map(({ key, label }) => {
                    const isOpen = openSection === key;
                    return (
                      <div key={key} style={{ marginBottom:6 }}>
                        {/* Akkordeon-Kopf */}
                        <button onClick={() => setOpenSection(isOpen ? null : key)}
                          style={{ width:"100%", display:"flex", justifyContent:"space-between", alignItems:"center", background: isOpen ? "rgba(200,169,110,0.1)" : "rgba(200,169,110,0.03)", border:`1px solid ${isOpen ? "rgba(200,169,110,0.4)" : "rgba(200,169,110,0.15)"}`, borderRadius: isOpen ? "6px 6px 0 0" : 6, padding:"10px 14px", cursor:"pointer", fontFamily:"Georgia,serif", color: isOpen ? gold : "#7a6040", fontSize:12, letterSpacing:1, transition:"all 0.2s" }}>
                          <span>{label}</span>
                          <span style={{ fontSize:10 }}>{isOpen ? "▲" : "▼"}</span>
                        </button>

                        {/* Akkordeon-Inhalt */}
                        {isOpen && (
                          <div style={{ border:`1px solid ${lightMode?"rgba(80,30,120,0.3)":"rgba(200,169,110,0.15)"}`, borderTop:"none", borderRadius:"0 0 6px 6px", padding:"12px 14px", background:"transparent" }}>

                            {/* 2er */}
                            {key === "2er" && (
                              <div style={{ display:"flex", flexDirection:"column", gap:9 }}>
                                {CARD_NUMS.filter(n => n !== cardDetail).map(n => {
                                  const combo = getCombo(cardDetail, n);
                                  if (!combo) return null;
                                  return (
                                    <div key={n} style={{ borderBottom:"1px solid rgba(200,169,110,0.06)", paddingBottom:9 }}>
                                      <div style={{ fontSize:11, color:lightMode?"#2a0850":gold, marginBottom:3 }}>{SYMBOLS[n]} {n}. {CARDS[n].name}</div>
                                      <div style={{ fontSize:12, color:lightMode?"#2a0850":"#9a8a72", lineHeight:1.7 }}>{combo}</div>
                                    </div>
                                  );
                                })}
                              </div>
                            )}

                            {/* 3er */}
                            {key === "3er" && (() => {
                              const matching = CLUSTERS["3er"].filter(c => c.karten.includes(cardDetail));
                              if (matching.length === 0) return (
                                <div style={{ fontSize:12, color:lightMode?"#2a0850":"#5a4a34", fontStyle:"italic" }}>
                                  Keine bekannten 3er-Cluster für diese Karte.
                                </div>
                              );
                              return (
                                <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
                                  {matching.map((c, i) => (
                                    <div key={i} style={{ borderBottom:"1px solid rgba(200,169,110,0.06)", paddingBottom:10 }}>
                                      <div style={{ display:"flex", gap:6, alignItems:"center", marginBottom:4, flexWrap:"wrap" }}>
                                        {c.karten.map((k, ki) => (
                                          <span key={ki} style={{ fontSize:10, color: k === cardDetail ? (lightMode?"#2a0850":gold) : (lightMode?"#2a0850":"#9a8a72") }}>
                                            {SYMBOLS[k]} {CARDS[k].name}{ki < c.karten.length-1 ? " ·" : ""}
                                          </span>
                                        ))}
                                      </div>
                                      <div style={{ display:"inline-block", background:"rgba(200,169,110,0.1)", border:`1px solid ${lightMode?"rgba(80,30,120,0.3)":"rgba(200,169,110,0.25)"}`, borderRadius:3, padding:"1px 6px", fontSize:8.5, color:lightMode?"#2a0850":gold, marginBottom:5, letterSpacing:0.5 }}>{c.label}</div>
                                      <div style={{ fontSize:12, color:lightMode?"#2a0850":"#9a8a72", lineHeight:1.7 }}>{c.text}</div>
                                    </div>
                                  ))}
                                </div>
                              );
                            })()}

                            {/* 4er */}
                            {key === "4er" && (() => {
                              const matching = CLUSTERS["4er"].filter(c => c.karten.includes(cardDetail));
                              if (matching.length === 0) return (
                                <div style={{ fontSize:12, color:lightMode?"#2a0850":"#5a4a34", fontStyle:"italic" }}>
                                  Keine bekannten 4er-Cluster für diese Karte.
                                </div>
                              );
                              return (
                                <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
                                  {matching.map((c, i) => (
                                    <div key={i} style={{ borderBottom:"1px solid rgba(200,169,110,0.06)", paddingBottom:10 }}>
                                      <div style={{ display:"flex", gap:6, alignItems:"center", marginBottom:4, flexWrap:"wrap" }}>
                                        {c.karten.map((k, ki) => (
                                          <span key={ki} style={{ fontSize:10, color: k === cardDetail ? (lightMode?"#2a0850":gold) : (lightMode?"#2a0850":"#9a8a72") }}>
                                            {SYMBOLS[k]} {CARDS[k].name}{ki < c.karten.length-1 ? " ·" : ""}
                                          </span>
                                        ))}
                                      </div>
                                      <div style={{ display:"inline-block", background:"rgba(200,169,110,0.1)", border:`1px solid ${lightMode?"rgba(80,30,120,0.3)":"rgba(200,169,110,0.25)"}`, borderRadius:3, padding:"1px 6px", fontSize:8.5, color:lightMode?"#2a0850":gold, marginBottom:5, letterSpacing:0.5 }}>{c.label}</div>
                                      <div style={{ fontSize:12, color:lightMode?"#2a0850":"#9a8a72", lineHeight:1.7 }}>{c.text}</div>
                                    </div>
                                  ))}
                                </div>
                              );
                            })()}

                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : (<>
              <div style={{ marginBottom:12 }}>
                <input placeholder="Karte suchen…" value={search} onChange={e => setSearch(e.target.value)}
                  style={{ width:"100%", padding:"6px 12px", background:"rgba(200,169,110,0.03)", border:`1px solid ${lightMode?"rgba(80,30,120,0.3)":"rgba(200,169,110,0.15)"}`, borderRadius:5, color:gold, fontFamily:"Georgia,serif", fontSize:11, outline:"none", boxSizing:"border-box" }} />
              </div>
              <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(128px,1fr))", gap:8 }}>
                {filteredCards().map(num => (
                  <button key={num} onClick={() => setCardDetail(num)}
                    style={{ background:"rgba(200,169,110,0.015)", border:`1px solid ${lightMode?"rgba(80,30,120,0.3)":"rgba(200,169,110,0.1)"}`, borderRadius:8, padding:"12px 8px", cursor:"pointer", color:"#7a6a54", textAlign:"center", fontFamily:"Georgia,serif", transition:"all 0.18s" }}
                    onMouseEnter={e => { e.currentTarget.style.borderColor=lightMode?"#c8a8e0":"rgba(200,169,110,0.3)"; e.currentTarget.style.color=gold; }}
                    onMouseLeave={e => { e.currentTarget.style.borderColor=lightMode?"rgba(80,30,120,0.3)":"rgba(200,169,110,0.1)"; e.currentTarget.style.color="#7a6a54"; }}>
                    <div style={{ fontSize:24 }}>{SYMBOLS[num]}</div>
                    <div style={{ fontSize:9, marginTop:5, color:lightMode?"#2a0850":"#7a6040" }}>{num}.</div>
                    <div style={{ fontSize:11, marginTop:2, lineHeight:1.3 }}>{CARDS[num].name}</div>
                    <div style={{ fontSize:8, marginTop:4, color:"#4a3a24", lineHeight:1.4 }}>{CARDS[num].kw.split(',').slice(0,2).join(',')}</div>
                  </button>
                ))}
              </div>
            </>)}
          </div>
        )}
          </main>
          {!writingFullWidth && <aside className="lenapp-side-right">{renderRightRail()}</aside>}
        </div>
      </div>

      <div style={{ textAlign:"center", padding:"14px 20px", borderTop:`1px solid ${lightMode?"rgba(80,30,120,0.3)":"rgba(200,169,110,0.15)"}` }}>
        <div style={{ display:"flex", justifyContent:"center", gap:10, marginBottom:14, flexWrap:"wrap" }}>
          <a href="https://www.annabenoir.de/service-page/deep-dive" target="_blank" rel="noopener noreferrer"
            style={{ background:"rgba(200,169,110,0.12)", border:"1px solid rgba(200,169,110,0.4)", color:lightMode?"#5a1080":"#c8a96e", padding:"8px 18px", borderRadius:20, cursor:"pointer", fontSize:12, fontFamily:"Georgia,serif", textDecoration:"none", letterSpacing:1 }}>
            ✨ Frag Anna
          </a>
          <a href="https://lenormand-app-tau.vercel.app/#post-6e0c1574-97d2-40ca-8ff2-dfb9507f71e6" target="_blank" rel="noopener noreferrer"
            style={{ background:"transparent", border:`1px solid ${lightMode?"rgba(80,30,120,0.3)":"rgba(200,169,110,0.2)"}`, color:lightMode?"#2a0850":"#7a6040", padding:"8px 18px", borderRadius:20, cursor:"pointer", fontSize:12, fontFamily:"Georgia,serif", textDecoration:"none", letterSpacing:1 }}>
            🐞 Fehler melden
          </a>
          <button onClick={toggleTheme}
            style={{ background:"transparent", border:`1px solid ${lightMode?"rgba(80,30,120,0.3)":"rgba(200,169,110,0.2)"}`, color:lightMode?"#2a0850":"#7a6040", padding:"8px 18px", borderRadius:20, cursor:"pointer", fontSize:12, fontFamily:"Georgia,serif", letterSpacing:1 }}>
            {lightMode ? "🌙 Dunkel" : "☀️ Hell"}
          </button>
          {isGuest ? (
            <button onClick={() => setView("forum-login-noetig")}
              style={{ background:"transparent", border:`1px solid ${lightMode?"rgba(80,30,120,0.3)":"rgba(200,169,110,0.15)"}`, color:lightMode?"#2a0850":"#5a4a34", padding:"8px 18px", borderRadius:20, cursor:"pointer", fontSize:12, fontFamily:"Georgia,serif", letterSpacing:1 }}>
              ↪ Login
            </button>
          ) : (
            <button onClick={handleLogout}
              style={{ background:"transparent", border:`1px solid ${lightMode?"rgba(80,30,120,0.3)":"rgba(200,169,110,0.15)"}`, color:lightMode?"#2a0850":"#5a4a34", padding:"8px 18px", borderRadius:20, cursor:"pointer", fontSize:12, fontFamily:"Georgia,serif", letterSpacing:1 }}>
              ↩ Logout
            </button>
          )}
          <button onClick={() => setView("impressum")}
            style={{ background:"transparent", border:`1px solid ${lightMode?"rgba(80,30,120,0.3)":"rgba(200,169,110,0.15)"}`, color:lightMode?"#2a0850":"#5a4a34", padding:"8px 18px", borderRadius:20, cursor:"pointer", fontSize:12, fontFamily:"Georgia,serif", letterSpacing:1 }}>
            Impressum
          </button>
          <button onClick={() => setView("agb")}
            style={{ background:"transparent", border:`1px solid ${lightMode?"rgba(80,30,120,0.3)":"rgba(200,169,110,0.15)"}`, color:lightMode?"#2a0850":"#5a4a34", padding:"8px 18px", borderRadius:20, cursor:"pointer", fontSize:12, fontFamily:"Georgia,serif", letterSpacing:1 }}>
            AGB
          </button>
        </div>

        <div style={{ fontSize:9, color:lightMode?"#2a0850":"#2a1a08", letterSpacing:3, marginBottom:4 }}>
          ANNA BENOIR · LENORMAND MATRIX · 2014 · ALLE RECHTE VORBEHALTEN
        </div>
        <div style={{ fontSize:9, color:lightMode?"#2a0850":"#2a1a08", fontStyle:"italic", letterSpacing:1 }}>
          Diese App dient der Inspiration und Unterhaltung. Die Deutungen ersetzen keine professionelle Beratung.
        </div>
      </div>
    </div>
  );
}

'use strict';

// Single source for the rules text, shared by the in-game pop-over and /rules.
window.HotTakeRules = {
  html({ pointsToWin = 7, handSize = 7 } = {}) {
    return `
      <h3>Setup</h3>
      <ol>
        <li>One person starts a game and becomes the <strong>host</strong>. Everyone else joins on their phone
            by scanning the QR code or typing the 4-letter room code. You need 3 to 12 players.</li>
        <li>The host picks one or more decks and the settings, then starts the game.</li>
        <li>Everyone is dealt ${handSize} answer cards.</li>
      </ol>
      <h3>Each round</h3>
      <ol>
        <li>One player is the <strong>judge</strong>. The judge role rotates every round.</li>
        <li>The judge reads the prompt card out loud.</li>
        <li>Everyone else secretly plays the answer card that fits best. A <strong>Pick 2</strong> prompt takes
            two cards, filled into the blanks in the order you tap them.</li>
        <li>Once everyone has played, the answers are shuffled and shown on every phone without names.
            The judge reads each one aloud and picks a favorite.</li>
        <li>Whoever played the winning answer scores 1 point. Hands refill to ${handSize} cards.</li>
      </ol>
      <h3>Winning</h3>
      <p>The first player to reach <strong>${pointsToWin} points</strong> wins.</p>
      <h3>Special moves</h3>
      <ul>
        <li><strong>Mulligan (free, once per game):</strong> don't like your cards? Throw back your whole hand
            and draw a new one. You can do this while cards are being played, if you haven't played yet
            and aren't the judge.</li>
        <li><strong>Trade in (costs 1 point):</strong> after your mulligan is used up, you can still swap your
            hand by spending a point.</li>
      </ul>
      <h3>Fine print</h3>
      <ul>
        <li>Every answer card in a deck is unique, so two players can never play the same answer in a round.</li>
        <li>If your phone drops, reopen the link within 2 minutes to get your seat and score back.
            The round won't wait for you.</li>
        <li>If the judge disappears, the host can skip the round from the Scores menu. Played cards go back
            to their owners.</li>
      </ul>
      <h3>Credits</h3>
      <p>Card text from <a href="https://www.cardsagainsthumanity.com" target="_blank" rel="noopener">Cards Against Humanity</a>,
         used under <a href="https://creativecommons.org/licenses/by-nc-sa/4.0/" target="_blank" rel="noopener">CC BY-NC-SA 4.0</a>.
         Hot Take is not affiliated with Cards Against Humanity LLC.</p>`;
  },
};

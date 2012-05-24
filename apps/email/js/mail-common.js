/**
 * UI infrastructure code and utility code for the gaia email app.
 **/

var mozL10n = document.mozL10n;

function dieOnFatalError(msg) {
  console.error('FATAL:', msg);
  throw new Error(msg);
}

var fldNodes, msgNodes, cmpNodes, supNodes, tngNodes;
function processTemplNodes(prefix) {
  var holder = document.getElementById('templ-' + prefix),
      nodes = {},
      node = holder.firstElementChild,
      reInvariant = new RegExp('^' + prefix + '-');
  while (node) {
    var classes = node.classList, found = false;
    for (var i = 0; i < classes.length; i++) {
      if (reInvariant.test(classes[i])) {
        var name = classes[i].substring(prefix.length + 1);
        nodes[name] = node;
        found = true;
        break;
      }
    }
    if (!found) {
      console.warn('Bad template node for prefix "' + prefix +
                   '" for node with classes:', classes);
    }

    node = node.nextElementSibling;
  }

  return nodes;
}
function populateTemplateNodes() {
  fldNodes = processTemplNodes('fld');
  msgNodes = processTemplNodes('msg');
  cmpNodes = processTemplNodes('cmp');
  supNodes = processTemplNodes('sup');
  tngNodes = processTemplNodes('tng');
}

/**
 * Add an event listener on a container that, when an event is encounted on
 * a descendant, walks up the tree to find the immediate child of the container
 * and tells us what the click was on.
 */
function bindContainerHandler(containerNode, eventName, func) {
  containerNode.addEventListener(eventName, function(event) {
    var node = event.target;
    // bail if they clicked on the container and not a child...
    if (node === containerNode)
      return;
    while (node && node.parentNode !== containerNode) {
      node = node.parentNode;
    }
    func(node, event);
  }, false);
}

/**
 * Fairly simple card abstraction with support for simple horizontal animated
 * transitions.  We are cribbing from deuxdrop's mobile UI's cards.js
 * implementation created jrburke.
 */
var Cards = {
  /**
   * @dictof[
   *   @key[name String]
   *   @value[@dict[
   *     @key[name String]{
   *       The name of the card, which should also be the name of the css class
   *       used for the card when 'card-' is prepended.
   *     }
   *     @key[modes @dictof[
   *       @key[modeName String]
   *       @value[modeDef @dict[
   *         @key[tray Boolean]{
   *           Should this card be displayed as a tray that leaves the edge of
   *           the adjacent card visible?  (The width of the edge being a
   *           value consistent across all cards.)
   *         }
   *       ]
   *     ]]
   *     @key[constructor Function]{
   *       The constructor to use to create an instance of the card.
   *     }
   *   ]]
   * ]
   */
  _cardDefs: {},

  /**
   * @listof[@typedef[CardInstance @dict[
   *   @key[domNode]{
   *   }
   *   @key[cardDef]
   *   @key[modeDef]
   *   @key[left Number]{
   *     Left offset of the card in #cards.
   *   }
   *   @key[cardImpl]{
   *     The result of calling the card's constructor.
   *   }
   * ]]]{
   *   Existing cards, left-to-right, new cards getting pushed onto the right.
   * }
   */
  _cardStack: [],
  _activeCardIndex: null,

  _containerNode: null,
  _cardsNode: null,
  /**
   * DOM template nodes for the cards.
   */
  _templateNodes: null,

  /**
   * The DOM nodes that should be removed from their parent when our current
   * transition ends.
   */
  _animatingDeadDomNodes: [],

  /**
   * Is a tray card visible, suggesting that we need to intercept clicks in the
   * tray region so that we can transition back to the thing visible because of
   * the tray and avoid the click triggering that card's logic.
   */
  _trayActive: false,
  /**
   * Are we eating all click events we see until we transition to the next
   * card (possibly due to a call to pushCard that has not yet occurred?).
   * Set by calling `eatEventsUntilNextCard`.
   */
  _eatingEventsUntilNextCard: false,

  TRAY_GUTTER_WIDTH: 60,

  /**
   * Initialize and bind ourselves to the DOM which should now be fully loaded.
   */
  _init: function() {
    this._containerNode = document.getElementById('cardContainer');
    if (window.innerWidth > 320)
      this._containerNode.style.width = '320px';
    if (window.innerHeight > 480)
      this._containerNode.style.height = '480px';
    this._cardsNode = document.getElementById('cards');
    this._templateNodes = processTemplNodes('card');

    this._containerNode.addEventListener('click',
                                         this._onMaybeTrayIntercept.bind(this),
                                         true);

    this._adjustCardSizes();
    window.addEventListener('resize', this._adjustCardSizes.bind(this), false);

    // XXX be more platform detecty. or just add more events. unless the
    // prefixes are already gone with webkit and opera?
    this._cardsNode.addEventListener('transitionend',
                                     this._onTransitionEnd.bind(this),
                                     false);
  },

  /**
   * If the tray is active and a click happens in the tray area, transition
   * back to the visible thing (which must be to our right currently.)
   */
  _onMaybeTrayIntercept: function(event) {
    if (this._eatingEventsUntilNextCard) {
      event.stopPropagation();
      return;
    }
    if (this._trayActive &&
        (event.clientX >
         this._containerNode.offsetWidth - this.TRAY_GUTTER_WIDTH)) {
      event.stopPropagation();
      this.moveToCard(this._activeCardIndex + 1);
    }
  },

  _adjustCardSizes: function() {
    var cardWidth = Math.min(320, window.innerWidth), //this._containerNode.offsetWidth,
        cardHeight = Math.min(480, window.innerHeight), //this._containerNode.offsetHeight,
        totalWidth = 0;

    for (var i = 0; i < this._cardStack.length; i++) {
      var cardInst = this._cardStack[i];
      var targetWidth = cardWidth;
      if (cardInst.modeDef.tray)
        targetWidth -= this.TRAY_GUTTER_WIDTH;
      cardInst.domNode.style.width = targetWidth + 'px';
      cardInst.domNode.style.height = cardHeight + 'px';

      cardInst.left = totalWidth;
      totalWidth += targetWidth;
    }
    this._cardsNode.style.width = totalWidth + 'px';
    this._cardsNode.style.height = cardHeight + 'px';
  },

  defineCard: function(cardDef) {
    if (!cardDef.name)
      throw new Error('The card type needs a name');
    if (this._cardDefs.hasOwnProperty(cardDef.name))
      throw new Error('Duplicate card name: ' + cardDef.name);
    this._cardDefs[cardDef.name] = cardDef;

    // normalize the modes
    for (var modeName in cardDef.modes) {
      var mode = cardDef.modes[modeName];
      if (!mode.hasOwnProperty('tray'))
        mode.tray = false;
      mode.name = modeName;
    }
  },

  /**
   * Push a card onto the card-stack.
   *
   * @args[
   *   @param[type]
   *   @param[mode String]{
   *   }
   *   @param[showMethod @oneof[
   *     @case['animate']{
   *       Perform an animated scrolling transition.
   *     }
   *     @case['immediate']{
   *       Immediately warp to the card without animation.
   *     }
   *     @case['none']{
   *       Don't touch the view at all.
   *     }
   *   ]]
   *   @param[args Object]{
   *     An arguments object to provide to the card's constructor when
   *     instantiating.
   *   }
   * ]
   */
  pushCard: function(type, mode, showMethod, args) {
    var cardDef = this._cardDefs[type];
    if (!cardDef)
      throw new Error('No such card def type: ' + type);
    var modeDef = cardDef.modes[mode];
    if (!modeDef)
      throw new Error('No such card mode: ' + mode);

    var domNode = this._templateNodes[type].cloneNode(true);

    var cardImpl = new cardDef.constructor(domNode, mode, args);
    var cardInst = {
      domNode: domNode,
      cardDef: cardDef,
      modeDef: modeDef,
      cardImpl: cardImpl,
    };
    var cardIndex = this._cardStack.length;
    this._cardStack.push(cardInst);
    this._cardsNode.appendChild(domNode);
    this._adjustCardSizes();
    if ('postInsert' in cardImpl)
      cardImpl.postInsert();

    // XXX for now, always animate... (Need to disable 'left' as an animatable
    // property, set left, and then re-enable.  Need to trigger one or more
    // reflows for that to work right.)
    if (showMethod !== 'none') {
      this._showCard(cardIndex, showMethod);
    }
  },

  _findCardUsingTypeAndMode: function(type, mode) {
    for (var i = 0; i < this._cardStack.length; i++) {
      var cardInst = this._cardStack[i];
      if (cardInst.cardDef.name === type &&
          cardInst.modeDef.name === mode) {
        return i;
      }
    }
    throw new Error('Unable to find card with type: ' + type + ' mode: ' +
                    mode);
  },

  _findCardUsingImpl: function(impl) {
    for (var i = 0; i < this._cardStack.length; i++) {
      var cardInst = this._cardStack[i];
      if (cardInst.cardImpl === impl)
        return i;
    }
    throw new Error('Unable to find card using impl:', impl);
  },

  _findCard: function(query) {
    if (Array.isArray(query))
      return this._findCardUsingTypeAndMode(query[0], query[1]);
    else if (typeof(query) === 'number') // index number
      return query;
    else
      return this._findCardUsingImpl(query);
  },

  moveToCard: function(query) {
    this._showCard(this._findCard(query), 'animate');
  },

  tellCard: function(query, what) {
    var cardIndex = this._findCard(query),
        cardInst = this._cardStack[cardIndex];
    if (!('told' in cardInst.cardImpl))
      console.warn("Tried to tell a card that's not listening!", query, what);
    else
      cardInst.cardImpl.told(what);
  },

  /**
   * Remove the card identified by its DOM node and all the cards to its right.
   * Pass null to remove all of the cards!
   *
   * @args[
   *   @param[cardDomNode]{
   *     The DOM node that is the first card to remove; all of the cards to its
   *     right will also be removed.  If null is passed it is understood you
   *     want to remove all cards.
   *   }
   *   @param[showMethod @oneof[
   *     @case['animate']{
   *       Perform an animated scrolling transition.
   *     }
   *     @case['immediate']{
   *       Immediately warp to the card without animation.
   *     }
   *     @case['none']{
   *       Remove the nodes immediately, don't do anything about the view
   *       position.  You only want to do this if you are going to push one
   *       or more cards and the last card will use a transition of 'immediate'.
   *     }
   *   ]]
   * ]
   */
  removeCardAndSuccessors: function(cardDomNode, showMethod) {
    if (!this._cardStack.length)
      return;

    var firstIndex, iCard, cardInst;
    if (cardDomNode == null) {
      firstIndex = 0;
    }
    else {
      for (iCard = this._cardStack.length - 1; iCard >= 0; iCard--) {
        cardInst = this._cardStack[iCard];
        if (cardInst.domNode === cardDomNode) {
          firstIndex = iCard;
          break;
        }
      }
      if (firstIndex === undefined)
        throw new Error('No card represented by that DOM node');
    }

    var deadCardInsts = this._cardStack.splice(
                          firstIndex, this._cardStack.length - firstIndex);
    for (iCard = 0; iCard < deadCardInsts.length; iCard++) {
      cardInst = deadCardInsts[iCard];
      try {
        cardInst.cardImpl.die();
      }
      catch (ex) {
        console.warn('Problem cleaning up card:', ex, '\n', ex.stack);
      }
      switch (showMethod) {
        case 'animate':
        case 'immediate': // XXX handle properly
          this._animatingDeadDomNodes.push(cardInst.domNode);
          break;
        case 'none':
          cardInst.domNode.parentNode.removeChild(cardInst.domNode);
          break;
      }
    }
    if (showMethod !== 'none') {
      var nextCardIndex = null;
      if (this._cardStack.length)
        nextCardIndex = this._cardStack.length - 1;
      this._showCard(nextCard, showMethod);
    }
  },

  _showCard: function(cardIndex, showMethod) {
    var cardInst = (cardIndex !== null) ? this._cardStack[cardIndex] : null;

    var targetLeft;
    if (cardInst)
      targetLeft = (-cardInst.left) + 'px';
    else
      targetLeft = '0px';

    var cardsNode = this._cardsNode;
    if (cardsNode.style.left !== targetLeft) {
      if (showMethod === 'immediate') {
        // XXX cross-platform support.
        cardsNode.style.MozTransitionProperty = 'none';
        // make sure the reflow sees the transition is turned off.
        cardsNode.clientWidth;
        // explicitly clear since there will be no animation
        this._eatingEventsUntilNextCard = false;
      }
      else {
        this._eatingEventsUntilNextCard = true;
      }

      cardsNode.style.left = targetLeft;

      if (showMethod === 'immediate') {
        // make sure the instantaneous transition is seen before we turn
        // transitions back on.
        cardsNode.clientWidth;
        cardsNode.style.MozTransitionProperty = 'left';
      }
    }
    else {
      // explicitly clear since there will be no animation
      this._eatingEventsUntilNextCard = false;
    }

    this._activeCardIndex = cardIndex;
    if (cardInst)
      this._trayActive = cardInst.modeDef.tray;
  },

  _onTransitionEnd: function(event) {
    if (this._eatingEventsUntilNextCard)
      this._eatingEventsUntilNextCard = false;
    if (this._animatingDeadDomNodes.length) {
      this._animatingDeadDomNodes.forEach(function(domNode) {
        if (domNode.parentNode)
          domNode.parentNode.removeChild(domNode);
      });
    }
  },

  /**
   * Helper that causes (some) events targeted at our cards to be eaten until
   * we get to the next card.  The idea is to avoid bugs caused by the user
   * still being able to click things while our cards are transitioning or
   * while we are performing a (reliable) async wait before we actually initiate
   * a pushCard in response to user stimulus.
   *
   * This is automatically triggered when performing an animated transition;
   * other code should only call this in the async wait case mentioned above.
   *
   * For example, we don't want the user to have 2 message readers happening
   * at the same time because they managed to click on a second message before
   * the first reader got displayed.
   */
  eatEventsUntilNextCard: function() {
    this._eatingEventsUntilNextCard = true;
  },

  /**
   * Stop eating events, presumably because eatEventsUntilNextCard was used
   * as a hack for a known-fast async operation to avoid bugs (where we knew
   * full well that we weren't going to show a card).
   */
  stopEatingEvents: function() {
    this._eatingEventsUntilNextCard = false;
  },

  /**
   * If there are any cards on the deck right now, log an error and clear them
   * all out.  Our caller is strongly asserting that there should be no cards
   * and the presence of any indicates a bug.
   */
  assertNoCards: function() {
    if (this._cardStack.length)
      throw new Error('There are ' + this._cardStack.length + ' cards but' +
                      ' there should be ZERO');
  },
};

////////////////////////////////////////////////////////////////////////////////
// Pretty date logic; copied from the SMS app.
// Based on Resig's pretty date

function prettyDate(time) {

  switch (time.constructor) {
    case String:
      time = parseInt(time);
      break;
    case Date:
      time = time.getTime();
      break;
  }

  var diff = (Date.now() - time) / 1000;
  var day_diff = Math.floor(diff / 86400);

  if (isNaN(day_diff))
    return '(incorrect date)';

  if (day_diff < 0 || diff < 0) {
    // future time
    return (new Date(time)).toLocaleFormat('%x %R');
  }

  return day_diff == 0 && (
    diff < 60 && 'Just Now' ||
    diff < 120 && '1 Minute Ago' ||
    diff < 3600 && Math.floor(diff / 60) + ' Minutes Ago' ||
    diff < 7200 && '1 Hour Ago' ||
    diff < 86400 && Math.floor(diff / 3600) + ' Hours Ago') ||
    day_diff == 1 && 'Yesterday' ||
    day_diff < 7 && (new Date(time)).toLocaleFormat('%A') ||
    (new Date(time)).toLocaleFormat('%x');
}

(function() {
  var updatePrettyDate = function updatePrettyDate() {
    var labels = document.querySelectorAll('[data-time]');
    var i = labels.length;
    while (i--) {
      labels[i].textContent = prettyDate(labels[i].dataset.time);
    }
  };
  var timer = setInterval(updatePrettyDate, 60 * 1000);

  window.addEventListener('message', function visibleAppUpdatePrettyDate(evt) {
    var data = evt.data;
    if (data.message !== 'visibilitychange')
      return;
    clearTimeout(timer);
    if (!data.hidden) {
      updatePrettyDate();
      timer = setInterval(updatePrettyDate, 60 * 1000);
    }
  });
})();

////////////////////////////////////////////////////////////////////////////////

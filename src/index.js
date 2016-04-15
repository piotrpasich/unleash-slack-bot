var request = require('request'),
    express = require('express'),
    config  = require('./config.json'),
    cors    = require('cors'),
    Firebase = require('firebase'),
    bodyParser = require('body-parser'),
    rollbar = require('rollbar'),
    Card = require('./model/card'),
    cardService = require('./service/cardService'),
    app  = express(),
    ref = new Firebase(config.firebaseUrl),
    slackRef = ref.child('slack'),
    debugMode = config.debugMode === 'true';

var users = {
  general: {
    name: config.notificationsChannel
  }
};

app.use(cors());
app.use(bodyParser.json({extended: true}));

// Authenticate with Firebase
ref.authWithCustomToken( config.firebaseToken, function(error) {
  if (error) {
    console.log('Authentication Failed!', error);
    res.end();
  }

  console.log('Authenticated to Firebase!');

  setInterval(
    function () {
      getUsersList(function() {
        checkDueDates();
      });
    },
    1000 * 60 * 60
  );


  app.post('/notify', notifyOnSlack);
});

function notifyOnSlack(req, res) {
  if (req.body.debugMode || debugMode) {
    res.end('debug mode enabled: aborting posting the notification');
    return;
  }

  res.setHeader('Access-Control-Allow-Origin', '*');

  slackRef.child(req.body.uid).once('value', function(snapshot) {
    if (snapshot.val() == req.body.token && users[req.body.user]) {
      var channel = req.body.user === 'general' ? users[req.body.user].name
        : '@' + users[req.body.user].name;

      var data = {
        text: req.body.text,
        channel: channel,
        token: config.slackToken,
        icon_url: config.iconUrl,
        username: config.botUsername,
        attachments: []
      };

      if (req.body.attachments) {
        data.attachments = JSON.stringify(formatAttachments(req.body));
      }

      request.post(
        {
          url:'https://slack.com/api/chat.postMessage',
          form: data
        },
        function(err, httpResponse, body) {
          console.log('Posted a notification: ', body);
          rollbar.reportMessage('Posted a notification ' + body, 'info');
        }
      );

      res.end('ok');
    } else {
      if (!(snapshot.val() == req.body.token)) {
        res.end('invalid token');
        rollbar.reportMessage('Invalid token: ' + req.body.token, 'warning');
        return;
      }
      if (!users[req.body.user]) {
        res.end('no such channel/user');
        rollbar.reportMessage('Unleash email not registered in Slack: ' + req.body.user, 'warning');
      }
    }
  });
}

function formatAttachments(body) {
  var attachments = body.attachments;

  // Add URL to the card
  if (body.queryString) {
    attachments.map(function(attachment) {
      attachment.title_link = config.siteUrl + body.queryString;
      return attachment;
    })
  }

  return attachments;
}

function getUsersList(callback) {
  request.post({
    url:'https://slack.com/api/users.list',
    form: {
      token: config.slackToken
    }
  }, function(err, httpResponse, body) {
    JSON.parse(body).members.map(function(user) {
      user.profile && user.profile.email && (users['@' + user.profile.email.replace(/\+.*?@/, '@')] = user);
    });
    callback();
  });
}

function checkDueDates() {
  ref.child('users').once('value', function(snapshot) {
    snapshot.forEach(function(snapshot) {

      var email = snapshot.val().google.email;
      // Check if Slack user for a given email address exists
      if (!users['@' + email]) {
        return;
      }

      snapshot.child('cards').forEach(function(firebaseCard) {
        var card = new Card();
        card.fromFirebase(firebaseCard);

        if (cardService.shouldDueDateNotificationBePosted(card, users['@' + email].tz_offset)) {
          postPrivateNotification(firebaseCard, email);
          postUnleasherNotification(firebaseCard, email);
        }
      });
    });
  });
}

function getTimeDifferenceForCard(card, userTimezoneOffset) {
  var localTimeDifferenceInSeconds = (+new Date(card.child('dueDate').val()) - new Date()) / 1000;
  var localTimeOffsetInSeconds = (new Date().getTimezoneOffset()*60);
  var secondsInADay = 60 * 60 * 24;

  return Math.floor((localTimeDifferenceInSeconds - userTimezoneOffset - localTimeOffsetInSeconds) / secondsInADay) + 1;
}

function getGoalName(card) {
  var goalName = card.child('type').val();
  if (card.child('level').val()) {
    goalName += ' - Level ' + card.child('level').val();
  }

  return goalName;
}

function getTimeDifferenceText(timeDifference) {
  if (timeDifference < 0) {
    return 'overdue';
  } else if (timeDifference === 0) {
    return 'due today';
  } else if (timeDifference === 1) {
    return 'due tomorrow';
  } else {
    return 'due in ' + timeDifference + ' days';
  }
}

function postPrivateNotification(card, email) {
  var timeDifference = getTimeDifferenceForCard(card, users['@' + email].tz_offset);
  var slackHandle = '@' + users['@' + email].name;
  var message = 'Your "' + getGoalName(card) + '" goal is ' + getTimeDifferenceText(timeDifference) + '… Feel free to reach out to your Unleasher if you need any help!';

  postNotification(card, timeDifference,   {
    channel: slackHandle,
    text: message,
    token: config.slackToken,
    icon_url: config.iconUrl,
    username: config.botUsername,
    attachments: []
  });
}

function postUnleasherNotification(card, email) {
  if (!config.unleasherChannel) {
    console.error('No unleasher channel set!');
    return;
  }

  var currentUser = users['@' + email] || {};
  var timeDifference = getTimeDifferenceForCard(card, currentUser.tz_offset);
  var message = (currentUser.real_name || currentUser.name) + '\'s "' + getGoalName(card) + '" goal is ' + getTimeDifferenceText(timeDifference) + '!';

  postNotification(card, timeDifference, {
    channel: config.unleasherChannel,
    text: message,
    token: config.slackToken,
    icon_url: config.iconUrl,
    username: config.botUsername,
    attachments: []
  });
}

/**
 * Posts a notification to Slack
 * @param {Object} card
 * @param {Number} timeDifference
 * @param {Object} data
 * @param {String} data.channel - Slack channel or Slack registered user
 * @param {String} data.text - Notification contents
 */
function postNotification(card, timeDifference, data) {
  request.post(
    {
      url:'https://slack.com/api/chat.postMessage',
      form: data
    },
    function(err, httpResponse, body) {
      if (err || (body && body.ok === false)) {
        var msg = 'Couldn\'t post to ' + data.channel + '!';

        console.error(msg);

        rollbar.reportMessageWithPayloadData(msg, {
          level: 'error',
          data: data.text,
          response: body
        });
      } else {
        markNotificationAsSent(card, timeDifference);

        rollbar.reportMessageWithPayloadData('Posted a message to ' + data.channel, {
          level: 'info',
          data: data.text,
          response: body
        });
      }
  });
}

function markNotificationAsSent(card, timeDifference) {
  var cardRef = card.ref();
  var notificationsAlreadySent = {};

  notificationsAlreadySent[timeDifference] = true;

  cardRef.child('notificationsAlreadySent').update(notificationsAlreadySent);
}

app.use(rollbar.errorHandler(config.rollbarToken));

app.listen(8081);

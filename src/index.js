'use strict';

const
  bodyParser = require('body-parser'),
  express = require('express'),
  https = require('https'),
  crypto = require('crypto'),
  logger = require("./logger.js"),
  request = require('request');
var ConversationV1 = require('watson-developer-cloud/conversation/v1');

var RestClient = require('node-rest-client').Client;
      var restClient = new RestClient();

var app = express();

/*Conversation object*/
var conversation = new ConversationV1({
  username: process.env.CONVERSATION_USERNAME,
  password: process.env.CONVERSATION_PASSWORD,
  path: { workspace_id: process.env.CONVERSATION_WORKSPACE_ID },
  version_date: '2016-07-11'
});

var watson_context = null;

// App Secret can be retrieved from the App Dashboard
const APP_SECRET = process.env.MESSENGER_APP_SECRET;

// Arbitrary value used to validate a webhook
const VALIDATION_TOKEN = process.env.MESSENGER_VALIDATION_TOKEN;

// Generate a page access token for your page from the App Dashboard
const PAGE_ACCESS_TOKEN = process.env.MESSENGER_PAGE_ACCESS_TOKEN;

// URL where the app is running (include protocol). Used to point to scripts and 
// assets located at this address. 
const SERVER_URL = process.env.SERVER_URL;

if (!(APP_SECRET && VALIDATION_TOKEN && PAGE_ACCESS_TOKEN && SERVER_URL)) {
  logger.error("Missing config values");
  process.exit(1);
}

//app values
app.set('port', process.env.PORT || 5000);
app.use(bodyParser.json({ verify: verifyRequestSignature }));
app.use(express.static('public'));
app.set('view engine', 'ejs');

//GET request just to verify webhook url from fb dashbpard/webhook
app.get('/webhook', function (req, res) {
  if (req.query['hub.mode'] === 'subscribe' &&
    req.query['hub.verify_token'] === 'gota-fb-bot') {
    logger.log("Validating webhook");
    res.status(200).send(req.query['hub.challenge']);
  } else {
    logger.error("Failed validation. Make sure the validation tokens match.");
    res.sendStatus(403);
  }
});

/*
 * All callbacks for Messenger are POST-ed. They will be sent to the same
 * webhook. Be sure to subscribe your app to your page to receive callbacks
 * for your page. 
 * https://developers.facebook.com/docs/messenger-platform/product-overview/setup#subscribe_app
 *
 */
app.post('/webhook', function (req, res) {
  var data = req.body;
  logger.log(JSON.stringify(data));
  // Make sure this is a page subscription
  if (data.object == 'page') {
    // Iterate over each entry
    // There may be multiple if batched
    data.entry.forEach(function (pageEntry) {
      var pageID = pageEntry.id;
      var timeOfEvent = pageEntry.time;

      // Iterate over each messaging event
      pageEntry.messaging.forEach(function (messagingEvent) {
        if (messagingEvent.optin) {
          receivedAuthentication(messagingEvent);
        } else if (messagingEvent.message) {
          receivedMessage(messagingEvent);
        } else if (messagingEvent.delivery) {
          receivedDeliveryConfirmation(messagingEvent);
        } else if (messagingEvent.postback) {
          receivedPostback(messagingEvent);
        } else if (messagingEvent.read) {
          receivedMessageRead(messagingEvent);
        } else if (messagingEvent.account_linking) {
          receivedAccountLink(messagingEvent);
        } else {
          logger.log("Webhook received unknown messagingEvent: ", messagingEvent);
        }
      });
    });

    // Assume all went well.
    //
    // You must send back a 200, within 20 seconds, to let us know you've 
    // successfully received the callback. Otherwise, the request will time out.
    res.sendStatus(200);
  }
});


function replyByWatson(senderID, messageText) {
  conversation.message({
    input: { text: messageText },
    context: watson_context,
  }, (err, response) => {
    if (err) {
      logger.error('Error in watson response: ' + err); // something went wrong
    }
    watson_context = response.context;
    
    //End of conversation Call the required API to give user response
    logger.log("RESPONSE FROM WATSON" + JSON.stringify(response));
    if(response.output.nodes_visited[0]=='golf_search_request_confirmed'){
      restClient.get("https://akshay-api.herokuapp.com/gora/golfcourse?place="+response.context.place+"&date="+response.context.date, function (data, response) {
          // parsed response body as js object 
          logger.log(data);
          // raw response 
          //logger.log(response);

          sendGenericMessage(senderID, data);
      });

  }else if(response.output.nodes_visited[0]=='item_search_request_confirmed' || response.output.nodes_visited[0]=='item_search_request_confirmed_'){
      restClient.get("https://akshay-api.herokuapp.com/gora/ichibaitem?keyword="+response.context.item+"&gender="+response.context.gender, function (data, response) {
          // parsed response body as js object 
          logger.log(data);
          // raw response 
          //logger.log(response);
          sendGenericMessage_Ichiba(senderID, data);
      });

  }
  
  else if (response.output.text.length != 0) {
      logger.log(response.output.text[0]);
      sendTextMessage(senderID, response.output.text[0]);
    }
  });
}


/*
 * Authorization Event
 *
 * The value for 'optin.ref' is defined in the entry point. For the "Send to 
 * Messenger" plugin, it is the 'data-ref' field. Read more at 
 * https://developers.facebook.com/docs/messenger-platform/webhook-reference/authentication
 *
 */
function receivedAuthentication(event) {
  var senderID = event.sender.id;
  var recipientID = event.recipient.id;
  var timeOfAuth = event.timestamp;

  // The 'ref' field is set in the 'Send to Messenger' plugin, in the 'data-ref'
  // The developer can set this to an arbitrary value to associate the 
  // authentication callback with the 'Send to Messenger' click event. This is
  // a way to do account linking when the user clicks the 'Send to Messenger' 
  // plugin.
  var passThroughParam = event.optin.ref;

  console.log("Received authentication for user %d and page %d with pass " +
    "through param '%s' at %d", senderID, recipientID, passThroughParam,
    timeOfAuth);

  // When an authentication is received, we'll send a message back to the sender
  // to let them know it was successful.
  sendTextMessage(senderID, "Authentication successful");
}

/*
 * Message Event
 *
 * This event is called when a message is sent to your page. The 'message' 
 * object format can vary depending on the kind of message that was received.
 * Read more at https://developers.facebook.com/docs/messenger-platform/webhook-reference/message-received
 *
 * For this example, we're going to echo any text that we get. If we get some 
 * special keywords ('button', 'generic', 'receipt'), then we'll send back
 * examples of those bubbles to illustrate the special message bubbles we've 
 * created. If we receive a message with an attachment (image, video, audio), 
 * then we'll simply confirm that we've received the attachment.
 * 
 */
function receivedMessage(event) {

  //logger.log('#### Context: '+JSON.stringify(watson_resp == null?'null': watson_resp.context));

  var senderID = event.sender.id;
  var recipientID = event.recipient.id;
  var timeOfMessage = event.timestamp;
  var message = event.message;

  //logger.log("Received message for user %d and page %d at %d with message:",
  //  senderID, recipientID, timeOfMessage);
  logger.log('Message from user FB:  ' + JSON.stringify(message));

  var isEcho = message.is_echo;
  var messageId = message.mid;
  var appId = message.app_id;
  var metadata = message.metadata ;//== null ? '{}' : message.metadata; //metadeta is context
  //logger.log('!!!!!' + metadata);
  //var watsonContext = JSON.parse(metadata);
  // You may get a text or attachment but not both
  var messageText = message.text;
  var messageAttachments = message.attachments;
  var quickReply = message.quick_reply;

  if (isEcho) {
    // Just logging message echoes to console
    logger.log("Received echo for message %s and app %d with metadata %s",
      messageId, appId, metadata);
    return;
  } else if (quickReply) {
    var quickReplyPayload = quickReply.payload;
    console.log("Quick reply for message %s with payload %s",
      messageId, quickReplyPayload);

    sendTextMessage(senderID, "Quick reply tapped");
    return;
  }

  if (messageText) {

    replyByWatson(senderID, messageText);
    //return;
    //var respFromWatson = sendMessageToWatsonAndGetResponseText(senderID, messageText);

    // If we receive a text message, check to see if it matches any special
    // keywords and send back the corresponding example. Otherwise, just echo
    // the text we received.

    /*switch (messageText) {
      case 'image':
        sendImageMessage(senderID);
        break;

      case 'gif':
        sendGifMessage(senderID);
        break;

      case 'audio':
        sendAudioMessage(senderID);
        break;

      case 'video':
        sendVideoMessage(senderID);
        break;

      case 'file':
        sendFileMessage(senderID);
        break;

      case 'button':
        sendButtonMessage(senderID);
        break;

      case 'generic':
        sendGenericMessage(senderID);
        break;

      case 'receipt':
        sendReceiptMessage(senderID);
        break;

      case 'quick reply':
        sendQuickReply(senderID);
        break;

      case 'read receipt':
        sendReadReceipt(senderID);
        break;

      case 'typing on':
        sendTypingOn(senderID);
        break;

      case 'typing off':
        sendTypingOff(senderID);
        break;

      case 'account linking':
        sendAccountLinking(senderID);
        break;

      default: {

      }
    }*/
  } else if (messageAttachments) {
    sendTextMessage(senderID, "Message with attachment received");
  }
}


/*
 * Delivery Confirmation Event
 *
 * This event is sent to confirm the delivery of a message. Read more about 
 * these fields at https://developers.facebook.com/docs/messenger-platform/webhook-reference/message-delivered
 *
 */
function receivedDeliveryConfirmation(event) {
  var senderID = event.sender.id;
  var recipientID = event.recipient.id;
  var delivery = event.delivery;
  var messageIDs = delivery.mids;
  var watermark = delivery.watermark;
  var sequenceNumber = delivery.seq;

  if (messageIDs) {
    messageIDs.forEach(function (messageID) {
      console.log("Received delivery confirmation for message ID: %s",
        messageID);
    });
  }

  console.log("All message before %d were delivered.", watermark);
}


/*
 * Postback Event
 *
 * This event is called when a postback is tapped on a Structured Message. 
 * https://developers.facebook.com/docs/messenger-platform/webhook-reference/postback-received
 * 
 */
function receivedPostback(event) {
  var senderID = event.sender.id;
  var recipientID = event.recipient.id;
  var timeOfPostback = event.timestamp;

  // The 'payload' param is a developer-defined field which is set in a postback 
  // button for Structured Messages. 
  var payload = event.postback.payload;
  payload = JSON.parse(payload);
  logger.log("PAYLOAD=> "+JSON.stringify(payload));
  console.log("Received postback for user %d and page %d with payload '%s' " +
    "at %d", senderID, recipientID, payload, timeOfPostback);

  // When a postback is called, we'll send a message back to the sender to 
  // let them know it was successful

  var checkin = watson_context.date;
  var chch = checkin.substring(0,8);
  logger.log("CHCH=>  "+chch);
  var summ = (int)(checkin.substring(8,9)) + 1;
  logger.log("SUMM=>  "+summ);
  var checkout =   chch+summ;

  var url_hotels = "https://akshay-api.herokuapp.com/gora/hotels?cin="+checkin+"&cout="+checkout+"&lat="+payload.lat+"&lng="+payload.lng;
  logger.log("HOTEL_URL=> "+url_hotels);
  restClient.get(url_hotels, function (data, response) {
          // parsed response body as js object 
          logger.log(data);
          // raw response 
          //logger.log(response);

          sendGenericMessage_Hotels(senderID,data);
      });
}

/*
 * Message Read Event
 *
 * This event is called when a previously-sent message has been read.
 * https://developers.facebook.com/docs/messenger-platform/webhook-reference/message-read
 * 
 */
function receivedMessageRead(event) {
  var senderID = event.sender.id;
  var recipientID = event.recipient.id;

  // All messages before watermark (a timestamp) or sequence have been seen.
  var watermark = event.read.watermark;
  var sequenceNumber = event.read.seq;

  console.log("Received message read event for watermark %d and sequence " +
    "number %d", watermark, sequenceNumber);
}

/*
 * Account Link Event
 *
 * This event is called when the Link Account or UnLink Account action has been
 * tapped.
 * https://developers.facebook.com/docs/messenger-platform/webhook-reference/account-linking
 * 
 */
function receivedAccountLink(event) {
  var senderID = event.sender.id;
  var recipientID = event.recipient.id;

  var status = event.account_linking.status;
  var authCode = event.account_linking.authorization_code;

  console.log("Received account link event with for user %d with status %s " +
    "and auth code %s ", senderID, status, authCode);
}

/*
 * Send an image using the Send API.
 *
 */
function sendImageMessage(recipientId) {
  var messageData = {
    recipient: {
      id: recipientId
    },
    message: {
      attachment: {
        type: "image",
        payload: {
          url: SERVER_URL + "/assets/rift.png"
        }
      }
    }
  };

  callSendAPI(messageData);
}

/*
 * Send a Gif using the Send API.
 *
 */
function sendGifMessage(recipientId) {
  var messageData = {
    recipient: {
      id: recipientId
    },
    message: {
      attachment: {
        type: "image",
        payload: {
          url: SERVER_URL + "/assets/instagram_logo.gif"
        }
      }
    }
  };

  callSendAPI(messageData);
}

/*
 * Send audio using the Send API.
 *
 */
function sendAudioMessage(recipientId) {
  var messageData = {
    recipient: {
      id: recipientId
    },
    message: {
      attachment: {
        type: "audio",
        payload: {
          url: SERVER_URL + "/assets/sample.mp3"
        }
      }
    }
  };

  callSendAPI(messageData);
}

/*
 * Send a video using the Send API.
 *
 */
function sendVideoMessage(recipientId) {
  var messageData = {
    recipient: {
      id: recipientId
    },
    message: {
      attachment: {
        type: "video",
        payload: {
          url: SERVER_URL + "/assets/allofus480.mov"
        }
      }
    }
  };

  callSendAPI(messageData);
}

/*
 * Send a file using the Send API.
 *
 */
function sendFileMessage(recipientId) {
  var messageData = {
    recipient: {
      id: recipientId
    },
    message: {
      attachment: {
        type: "file",
        payload: {
          url: SERVER_URL + "/assets/test.txt"
        }
      }
    }
  };

  callSendAPI(messageData);
}

/*
 * Send a text message using the Send API.
 *
 */
function sendTextMessage(recipientId, messageText) {
  var messageData = {
    recipient: {
      id: recipientId
    },
    message: {
      text: messageText,
      metadata: "context"
    }
  };

  callSendAPI(messageData);
}

/*
 * Send a button message using the Send API.
 *
 */
function sendButtonMessage(recipientId) {
  var messageData = {
    recipient: {
      id: recipientId
    },
    message: {
      attachment: {
        type: "template",
        payload: {
          template_type: "button",
          text: "This is test text",
          buttons: [{
            type: "web_url",
            url: "https://www.oculus.com/en-us/rift/",
            title: "Open Web URL"
          }, {
            type: "postback",
            title: "Trigger Postback",
            payload: "DEVELOPER_DEFINED_PAYLOAD"
          }, {
            type: "phone_number",
            title: "Call Phone Number",
            payload: "+16505551234"
          }]
        }
      }
    }
  };

  callSendAPI(messageData);
}

/*
 * Send a Structured Message (Generic Message type) using the Send API.
 *
 */
function sendGenericMessage(recipientId, data) {
  var messageData = {
    recipient: {
      id: recipientId
    },
    message: {
      attachment: {
        type: "template",
        payload: {
          template_type: "generic",
          elements: [{
            title: data[0].name,
            subtitle: data[0].desc,
            item_url: data[0].book_url,
            image_url: data[0].picture,
            buttons: [{
              type: "web_url",
              url: data[0].book_url,
              title: "Book"
            }, {
              type: "web_url",
              title: "Reviews",
              url: data[0].reviews,
            },{
              type: "postback",
              title: "Find hotels",
              payload: JSON.stringify(data[0].location)
            }],
          }, {
            title: data[1].name,
            subtitle: data[1].desc,
            item_url: data[1].book_url,
            image_url: data[1].picture,
            buttons: [{
              type: "web_url",
              url: data[1].book_url,
              title: "Book"
            }, {
              type: "web_url",
              title: "Reviews",
              url: data[1].reviews,
            },{
              type: "postback",
              title: "Find hotels",
              payload: JSON.stringify(data[1].location)
            }],
          },
          {
            title: data[2].name,
            subtitle: data[2].desc,
            item_url: data[2].book_url,
            image_url: data[2].picture,
            buttons: [{
              type: "web_url",
              url: data[2].book_url,
              title: "Book"
            }, {
              type: "web_url",
              title: "Reviews",
              url: data[2].reviews,
            },{
              type: "postback",
              title: "Find hotels",
              payload: JSON.stringify(data[2].location)
            }],
          },
          {
            title: data[3].name,
            subtitle: data[3].desc,
            item_url: data[3].book_url,
            image_url: data[3].picture,
            buttons: [{
              type: "web_url",
              url: data[3].book_url,
              title: "Book"
            }, {
              type: "web_url",
              title: "Reviews",
              url: data[3].reviews,
            },{
              type: "postback",
              title: "Find hotels",
              payload: JSON.stringify(data[3].location)
            }],
          },
          {
            title: data[4].name,
            subtitle: data[4].desc,
            item_url: data[4].book_url,
            image_url: data[4].picture,
            buttons: [{
              type: "web_url",
              url: data[4].book_url,
              title: "Book"
            }, {
              type: "web_url",
              title: "Reviews",
              url: data[4].reviews,
            },{
              type: "postback",
              title: "Find hotels",
              payload: JSON.stringify(data[4].location)
            }],
          }]
        }
      }
    }
  };
  console.log("MESSAGE DATA++>>  "+JSON.stringify(messageData));

  callSendAPI(messageData);
}


//for hotels
function sendGenericMessage_Hotels(recipientId, data) {
  var messageData = {
    recipient: {
      id: recipientId
    },
    message: {
      attachment: {
        type: "template",
        payload: {
          template_type: "generic",
          elements: [{
            title: data[0].name,
            subtitle: "Minimum price: "+data[0].price+"\nRating: "+data[0].rating,
            item_url: data[0].book_url,
            image_url: data[0].picture,
            buttons: [{
              type: "web_url",
              url: data[0].book_url,
              title: "Buy"
            }, {
              type: "web_url",
              title: "Show website",
              url: data[0].reviews,
            }],
          }, {
            title: data[1].name,
            subtitle: "Minimum price: "+data[1].price+"\nRating: "+data[1].rating,
            item_url: data[1].book_url,
            image_url: data[1].picture,
            buttons: [{
              type: "web_url",
              url: data[1].book_url,
              title: "Buy"
            }, {
              type: "web_url",
              title: "Show website",
              url: data[1].reviews,
            }],
          },
          {
            title: data[2].name,
            subtitle: "Minimum price: "+data[2].price+"\nRating: "+data[2].rating,
            item_url: data[2].book_url,
            image_url: data[2].picture,
            buttons: [{
              type: "web_url",
              url: data[2].book_url,
              title: "Buy"
            }, {
              type: "web_url",
              title: "Show website",
              url: data[2].reviews,
            }],
          },
          {
            title: data[3].name,
            subtitle: "Minimum price: "+data[3].price+"\nRating: "+data[3].rating,
            item_url: data[3].book_url,
            image_url: data[3].picture,
            buttons: [{
              type: "web_url",
              url: data[3].book_url,
              title: "Buy"
            }, {
              type: "web_url",
              title: "Show website",
              url: data[3].reviews,
            }],
          },
          {
            title: data[4].name,
            subtitle: "Minimum price: "+data[4].price+"\nRating: "+data[4].rating,
            item_url: data[4].book_url,
            image_url: data[4].picture,
            buttons: [{
              type: "web_url",
              url: data[4].book_url,
              title: "Buy"
            }, {
              type: "web_url",
              title: "Show website",
              url: data[4].reviews,
            }],
          }]
        }
      }
    }
  };

  console.log("MESSAGE DATA++>>  "+JSON.stringify(messageData));

  callSendAPI(messageData);
}


//for ichiba
function sendGenericMessage_Ichiba(recipientId, data) {
  var messageData = {
    recipient: {
      id: recipientId
    },
    message: {
      attachment: {
        type: "template",
        payload: {
          template_type: "generic",
          elements: [{
            title: data[0].name,
            subtitle: data[0].desc,
            item_url: data[0].item_url,
            image_url: data[0].picture[0],
            buttons: [{
              type: "web_url",
              url: data[0].item_url,
              title: "Buy"
            }, {
              type: "web_url",
              title: "Show website",
              url: data[0].shop_url,
            }],
          }, {
            title: data[1].name,
            subtitle: data[1].desc,
            item_url: data[1].item_url,
            image_url: data[1].picture[0],
            buttons: [{
              type: "web_url",
              url: data[1].item_url,
              title: "Buy"
            }, {
              type: "web_url",
              title: "Show website",
              url: data[1].shop_url,
            }],
          },
          {
            title: data[2].name,
            subtitle: data[2].desc,
            item_url: data[2].item_url,
            image_url: data[2].picture[0],
            buttons: [{
              type: "web_url",
              url: data[2].item_url,
              title: "Buy"
            }, {
              type: "web_url",
              title: "Show website",
              url: data[2].shop_url,
            }],
          },
          {
            title: data[3].name,
            subtitle: data[3].desc,
            item_url: data[3].item_url,
            image_url: data[3].picture[0],
            buttons: [{
              type: "web_url",
              url: data[3].item_url,
              title: "Buy"
            }, {
              type: "web_url",
              title: "Show website",
              url: data[3].shop_url,
            }],
          },
          {
            title: data[4].name,
            subtitle: data[4].desc,
            item_url: data[4].item_url,
            image_url: data[4].picture[0],
            buttons: [{
              type: "web_url",
              url: data[4].item_url,
              title: "Buy"
            }, {
              type: "web_url",
              title: "Show website",
              url: data[4].shop_url,
            }],
          }]
        }
      }
    }
  };

  console.log("MESSAGE DATA++>>  "+JSON.stringify(messageData));

  callSendAPI(messageData);
}



/*
 * Send a receipt message using the Send API.
 *
 */
function sendReceiptMessage(recipientId) {
  // Generate a random receipt ID as the API requires a unique ID
  var receiptId = "order" + Math.floor(Math.random() * 1000);

  var messageData = {
    recipient: {
      id: recipientId
    },
    message: {
      attachment: {
        type: "template",
        payload: {
          template_type: "receipt",
          recipient_name: "Peter Chang",
          order_number: receiptId,
          currency: "USD",
          payment_method: "Visa 1234",
          timestamp: "1428444852",
          elements: [{
            title: "Oculus Rift",
            subtitle: "Includes: headset, sensor, remote",
            quantity: 1,
            price: 599.00,
            currency: "USD",
            image_url: SERVER_URL + "/assets/riftsq.png"
          }, {
            title: "Samsung Gear VR",
            subtitle: "Frost White",
            quantity: 1,
            price: 99.99,
            currency: "USD",
            image_url: SERVER_URL + "/assets/gearvrsq.png"
          }],
          address: {
            street_1: "1 Hacker Way",
            street_2: "",
            city: "Menlo Park",
            postal_code: "94025",
            state: "CA",
            country: "US"
          },
          summary: {
            subtotal: 698.99,
            shipping_cost: 20.00,
            total_tax: 57.67,
            total_cost: 626.66
          },
          adjustments: [{
            name: "New Customer Discount",
            amount: -50
          }, {
            name: "$100 Off Coupon",
            amount: -100
          }]
        }
      }
    }
  };

  callSendAPI(messageData);
}

/*
 * Send a message with Quick Reply buttons.
 *
 */
function sendQuickReply(recipientId) {
  var messageData = {
    recipient: {
      id: recipientId
    },
    message: {
      text: "What's your favorite movie genre?",
      quick_replies: [
        {
          "content_type": "text",
          "title": "Action",
          "payload": "DEVELOPER_DEFINED_PAYLOAD_FOR_PICKING_ACTION"
        },
        {
          "content_type": "text",
          "title": "Comedy",
          "payload": "DEVELOPER_DEFINED_PAYLOAD_FOR_PICKING_COMEDY"
        },
        {
          "content_type": "text",
          "title": "Drama",
          "payload": "DEVELOPER_DEFINED_PAYLOAD_FOR_PICKING_DRAMA"
        }
      ]
    }
  };

  callSendAPI(messageData);
}

/*
 * Send a read receipt to indicate the message has been read
 *
 */
function sendReadReceipt(recipientId) {
  console.log("Sending a read receipt to mark message as seen");

  var messageData = {
    recipient: {
      id: recipientId
    },
    sender_action: "mark_seen"
  };

  callSendAPI(messageData);
}

/*
 * Turn typing indicator on
 *
 */
function sendTypingOn(recipientId) {
  console.log("Turning typing indicator on");

  var messageData = {
    recipient: {
      id: recipientId
    },
    sender_action: "typing_on"
  };

  callSendAPI(messageData);
}

/*
 * Turn typing indicator off
 *
 */
function sendTypingOff(recipientId) {
  console.log("Turning typing indicator off");

  var messageData = {
    recipient: {
      id: recipientId
    },
    sender_action: "typing_off"
  };

  callSendAPI(messageData);
}

/*
 * Send a message with the account linking call-to-action
 *
 */
function sendAccountLinking(recipientId) {
  var messageData = {
    recipient: {
      id: recipientId
    },
    message: {
      attachment: {
        type: "template",
        payload: {
          template_type: "button",
          text: "Welcome. Link your account.",
          buttons: [{
            type: "account_link",
            url: SERVER_URL + "/authorize"
          }]
        }
      }
    }
  };

  callSendAPI(messageData);
}

/*
 * Call the Send API. The message data goes in the body. If successful, we'll 
 * get the message id in a response 
 *
 */
function callSendAPI(messageData) {
  request({
    uri: 'https://graph.facebook.com/v2.6/me/messages',
    qs: { access_token: PAGE_ACCESS_TOKEN },
    method: 'POST',
    json: messageData

  }, function (error, response, body) {
    if (!error && response.statusCode == 200) {
      var recipientId = body.recipient_id;
      var messageId = body.message_id;

      if (messageId) {
        logger.log("Successfully sent message with id %s to recipient %s",
          messageId, recipientId);
      } else {
        logger.log("Successfully called Send API for recipient %s",
          recipientId);
      }
    } else {
      console.error("Failed calling Send API", response.statusCode, response.statusMessage, body.error);
    }
  });
}



/*
 * Verify that the callback came from Facebook. Using the App Secret from 
 * the App Dashboard, we can verify the signature that is sent with each 
 * callback in the x-hub-signature field, located in the header.
 *
 * https://developers.facebook.com/docs/graph-api/webhooks#setup
 *
 */
function verifyRequestSignature(req, res, buf) {
  var signature = req.headers["x-hub-signature"];

  if (!signature) {
    // For testing, let's log an error. In production, you should throw an 
    // error.
    logger.error("Couldn't validate the signature.");
  } else {
    var elements = signature.split('=');
    var method = elements[0];
    var signatureHash = elements[1];

    var expectedHash = crypto.createHmac('sha1', APP_SECRET)
      .update(buf)
      .digest('hex');

    if (signatureHash != expectedHash) {
      throw new Error("Couldn't validate the request signature.");
    }
  }
}



logger.log('test');

// Start server
// Webhooks must be available via SSL with a certificate signed by a valid 
// certificate authority.
app.listen(app.get('port'), function () {
  console.log('Node app is running on port', app.get('port'));
});

# या update मध्ये काय fix केलं

## 1) Interview Mode / Test Mode — तोच प्रश्न सारखा येण्याचा मुख्य बग (server.js)
**Root cause:** सर्व्हर Gemini कडून आलेलं उत्तर `level` आणि `topic` selected value सोबत
**अक्षरशः तंतोतंत (byte-for-byte)** जुळतंय का ते तपासत होता. पण topic strings खूप लांब आणि
मराठी+इंग्रजी मिश्र आहेत (उदा. "Python basics — variables, loops, functions, OOP थोडक्यात").
Gemini तो मजकूर जसाच्या तसा परत पाठवण्याची शक्यता जवळपास शून्य होती — त्यामुळे प्रत्येक वेळी
validation fail व्हायचं आणि ॲप लगेच local fallback bank (फक्त १८ प्रश्न) कडे वळायचं. तोच छोटा bank
वारंवार वापरला जात असल्यामुळे "तोच प्रश्न सारखा येतो" असं वाटत होतं, आणि topic/level बदलूनही
काही फरक पडत नव्हता (कारण validation आधीच सगळीकडे fail होत होतं).

**Fix:** आता सर्व्हर स्वतःच निवडलेला level/topic/difficulty उत्तरावर लावतो (कारण ते आधीच माहीत
आहे), आणि Gemini कडून फक्त खरा प्रश्न+उत्तर इंग्रजीत आहे का एवढंच तपासतो. यामुळे online engine
आता खऱ्या अर्थाने वापरला जाईल, आणि प्रश्न वैविध्यपूर्ण येतील.

## 2) Grounding tool चं नाव जुनं होतं (server.js)
Google च्या सध्याच्या REST docs प्रमाणे grounding tool `googleSearch` (camelCase) असं
पाठवायला हवं; आधी `google_search` (snake_case) वापरलं जात होतं. दोन्ही आजही बहुतेकदा चालतात,
पण नवीन camelCase वापरून आम्ही हे official spec प्रमाणे केलं — जेणेकरून grounding शांतपणे बंद पडत असेल तर तेही टळेल.

## 3) Marathi Translation — आता चूक झाल्यास खरं कारण दिसतं (index.html)
आधी translation fail झाल्यावर एकच generic Marathi message दिसायची, त्यामुळे नक्की काय चुकतंय
(API key, quota, network) ते कळायचं नाही. आता त्याच message च्या शेवटी सर्व्हरने दिलेला actual
error सुद्धा दाखवला जातो, जेणेकरून debug करणं सोपं होईल. मूळ interview generation चा बग (#1)
दुरुस्त झाल्यामुळे translation engine ला जाणारा दबावही कमी होईल.

## 4) Notification dismiss — आता फक्त तात्पुरतं (index.html)
सुरुवातीला dismiss केलेली notification १५ दिवस कायमची लपवली जायची (localStorage मध्ये
कायमची exclude-list ठेवून, आणि सर्व्हरला पण ती list पाठवून ती future refresh मधून वगळली
जायची). नंतर सांगितल्याप्रमाणे हे बदललं:

- आता dismiss ("✕") फक्त **सध्याच्या यादीतून** ती notification काढतो.
- कुठलीही कायमची exclude-list ठेवली जात नाही — त्यामुळे पुढच्या refresh वेळी (manual बटण किंवा
  दर ६ तासांनी होणारा automatic sync) ती notification अजूनही live असेल तर परत दिसू शकते —
  आणि याच वेळी **कोणत्याही नवीन संधीसुद्धा त्याच batch सोबत नक्की येतात**, कारण जुनी dismiss
  आता कुठलीही नवीन entry अडवत नाही.
- चुकून/घाईत ✕ दाबलं गेलं तर लगेच toast मधल्या **Undo** बटणाने (६ सेकंद) परत आणता येतं —
  पुढचा refresh येण्याआधी लगेच हवं असल्यास.

## Deploy करताना लक्षात ठेवा
- Render → Environment मध्ये `GEMINI_API_KEY` बरोबर सेट आहे का ते पुन्हा तपासा.
- `/health` उघडून `geminiConfigured:true` दिसतंय का बघा.
- `/api-status` उघडून Gemini खरंच जोडलेला आहे का ते बघा — जर तिथेही error दिसत असेल, तर तो
  key/quota-specific issue आहे, कोडचा बग नाही (आणि आता error message नीट दिसेल).

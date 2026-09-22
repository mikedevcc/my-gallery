import type {Photo,Trip,Album} from './types';
const img=(id:string,w=1200)=>`https://images.unsplash.com/${id}?auto=format&fit=crop&w=${w}&q=80`;
const items:[string,string,string,string,string,boolean,string][]=[
['kyoto-path','Kyoto in the morning','photo-1493976040374-85c8e12f0c0e','Kyoto','2026-09-18',true,'wide'],
['japan-lantern','Quiet streets of Kyoto','photo-1493780474015-ba834fd0ce2f','Kyoto','2026-09-17',false,''],
['fuji-lake','A view of Mount Fuji','photo-1500534623283-312aade485b7','Mount Fuji','2026-09-16',true,''],
['tokyo-night','Tokyo after dark','photo-1519501025264-65ba15a82390','Tokyo','2026-09-12',false,'tall'],
['temple','Temple details','photo-1545569341-9eb8b30979d9','Kyoto','2026-09-10',true,''],
['japan-garden','Japanese garden','photo-1528360983277-13d401cdc186','Kyoto','2026-09-08',false,''],
['tokyo-crossing','City lights','photo-1519608487953-e999c86e7455','Tokyo','2026-08-24',false,'wide'],
['singapore','Gardens by the Bay','photo-1525625293386-3f8f99389edd','Singapore','2026-08-20',true,''],
['coast','Coast at golden hour','photo-1507525428034-b723cf961d3e','Australia','2026-08-18',true,''],
['mountains','Mountain air','photo-1464822759023-fed622ff2c3b','New Zealand','2026-08-15',false,''],
['iceland','Road through Iceland','photo-1476610182048-b716b8518aae','Iceland','2026-08-12',true,''],
['waterfall','The waterfall','photo-1433086966358-54859d0ed716','Iceland','2026-08-10',false,'tall'],
['japan-street','A little side street','photo-1480796927426-f609979314bd','Tokyo','2026-08-08',false,''],
['ocean','Blue hour by the sea','photo-1470252649378-9c29740c9fa8','Australia','2026-08-04',false,''],
['flower','Spring bloom','photo-1490750967868-88aa4486c946','Kyoto','2026-07-28',true,''],
['desert','Open landscape','photo-1509316785289-025f5b846b35','Australia','2026-07-22',false,''],
];
export const photos:Photo[]=items.map(([id,title,source,city,dateTaken,favorite,span],i)=>({id,title,src:img(source,2000),thumbnailSrc:img(source,900),width:span==='tall'?800:1200,height:span==='tall'?1200:800,filename:`IMG_${4321+i}.JPG`,dateTaken:`${dateTaken}T06:42:00`,location:{city,region:city==='Mount Fuji'?'Yamanashi':undefined,country:['Kyoto','Tokyo','Mount Fuji'].includes(city)?'Japan':city},camera:{make:'Sony',model:'A7 III',lens:'FE 24–70mm F2.8 GM',focalLength:'48 mm',aperture:'f/8',shutterSpeed:'1/320s',iso:100},favorite,tags:[city,'Travel',...(city==='Kyoto'?['Architecture']:[])],span,color:['#a8b6ad','#9aa9aa','#a3b5bc'][i%3]}));
export const trips:Trip[]=[
{slug:'japan-2026',name:'Japan 2026',dates:'10–24 Apr 2026',count:1248,places:'Tokyo · Kyoto · Osaka',cover:photos[0].thumbnailSrc},
{slug:'taiwan-2025',name:'Taiwan 2025',dates:'12–20 Nov 2025',count:842,places:'Taipei · Jiufen',cover:img('photo-1470004914212-05527e49370b')},
{slug:'iceland-2025',name:'Iceland 2025',dates:'1–12 Jun 2025',count:521,places:'Reykjavík · South Coast',cover:photos[10].thumbnailSrc},
{slug:'australia-2025',name:'Australia 2025',dates:'10–24 Mar 2025',count:983,places:'Sydney · Melbourne',cover:photos[8].thumbnailSrc},
{slug:'singapore-2025',name:'Singapore',dates:'5–8 Dec 2025',count:318,places:'Singapore',cover:photos[7].thumbnailSrc},
{slug:'new-zealand-2025',name:'New Zealand 2025',dates:'14–30 Sep 2025',count:1102,places:'Queenstown · Milford Sound',cover:photos[9].thumbnailSrc}
];
export const albums:Album[]=[['Favorites',243,photos[2].thumbnailSrc],['Food',316,img('photo-1546069901-ba9599a7e63c')],['Temples',521,photos[4].thumbnailSrc],['Family',642,img('photo-1511895426328-dc8714191300')],['Landscapes',1024,photos[9].thumbnailSrc],['Cities',736,photos[6].thumbnailSrc],['People',421,img('photo-1529156069898-49953e39b3ac')],['Videos',318,photos[8].thumbnailSrc]].map(([name,count,cover])=>({slug:String(name).toLowerCase(),name:String(name),count:Number(count),cover:String(cover)}));

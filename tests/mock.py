import json,datetime as dt
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
from urllib.parse import urlparse
now=dt.datetime.now(dt.timezone.utc)
iso=lambda d:(now+dt.timedelta(days=d,hours=3)).strftime("%Y-%m-%dT%H:%M:%SZ")
R={
"/api/v1/users/self/profile":{"name":"Rain Shen"},
"/api/v1/courses":[{"id":1,"name":"Corporate Finance","course_code":"B6300"},{"id":2,"name":"Managerial Economics","course_code":"B6601"}],
"/api/v1/planner/items":[
 {"plannable_type":"assignment","course_id":1,"html_url":"/courses/1/assignments/9","plannable":{"title":"Problem Set 2","due_at":iso(0.2),"points_possible":10},"submissions":{"submitted":False}},
 {"plannable_type":"quiz","course_id":2,"html_url":"/courses/2/quizzes/3","plannable":{"title":"Quiz 1","due_at":iso(3),"points_possible":5},"submissions":{"submitted":True}},
 {"plannable_type":"announcement","course_id":2,"plannable":{"title":"x"}},
 {"plannable_type":"discussion_topic","course_id":1,"html_url":"/courses/1/discussion_topics/4","plannable":{"title":"Case prep: Marriott","todo_date":iso(9)},"submissions":{}}],
"/api/v1/courses/1/modules":[{"id":11,"name":"Week 1 – Valuation","items":[{"type":"SubHeader","title":"Before class"},{"type":"File","title":"Brealey Ch. 2.pdf","html_url":"/courses/1/modules/items/1","content_id":100},{"type":"ExternalUrl","title":"HBR case: Marriott","external_url":"https://hbr.org/x"},{"type":"SubHeader","title":"In class"},{"type":"File","title":"Session 1 Slides.pptx","html_url":"/courses/1/modules/items/2","content_id":101},{"type":"Assignment","title":"PS1"}]}],
"/api/v1/courses/1/files":[{"id":100,"display_name":"Brealey Ch. 2.pdf","folder_id":5},{"id":200,"display_name":"Lecture 2.pdf","folder_id":5,"url":"https://x/dl"}],
"/api/v1/courses/1/folders":[{"id":5,"full_name":"course files/Slides"}],
"/api/v1/courses/2/modules":[],
}
class H(BaseHTTPRequestHandler):
  def log_message(s,*a):pass
  def do_GET(s):
    p=urlparse(s.path).path
    if p in R: b=json.dumps(R[p]).encode();s.send_response(200)
    else: b=b'{"errors":"unauthorized"}';s.send_response(401 if p.endswith("files") else 404)
    s.send_header("Content-Type","application/json");s.end_headers();s.wfile.write(b)
ThreadingHTTPServer(("127.0.0.1",9001),H).serve_forever()

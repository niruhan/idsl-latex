import http.client
import unittest

import test_app
from test_app import Client


class FileImageTests(unittest.TestCase):
    setUp=test_app.AppTests.setUp
    tearDown=test_app.AppTests.tearDown
    invite=test_app.AppTests.invite
    lab_signup=test_app.AppTests.lab_signup

    def test_image_bytes_type_version_access_and_restrictive_svg_policy(self):
        svg='<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'
        self.assertEqual(self.owner.call(self.base+'/file','PUT',{'path':'images/figure.SVG','content':svg,'revision':0})[0],200)
        url=self.base+'/image?path=images%2Ffigure.SVG&v=1'
        self.assertEqual(self.owner.call(url),(200,svg.encode()))
        conn=http.client.HTTPConnection('127.0.0.1',self.port)
        conn.request('GET',url,headers={'Cookie':self.owner.cookie});response=conn.getresponse();response.read()
        self.assertEqual(response.getheader('Content-Type'),'image/svg+xml')
        self.assertIn("default-src 'none'",response.getheader('Content-Security-Policy'));self.assertIn('sandbox',response.getheader('Content-Security-Policy'))
        self.assertEqual(response.getheader('Cache-Control'),'no-store');self.assertEqual(response.getheader('X-Content-Type-Options'),'nosniff');conn.close()
        self.assertEqual(self.owner.call(url.replace('v=1','v=0'))[0],409)
        self.assertEqual(self.owner.call(self.base+'/image?path=main.tex')[0],415)
        self.assertEqual(self.owner.call(self.base+'/image?path=missing.png')[0],404)
        self.assertEqual(self.owner.call(self.base+'/image?path=../figure.svg')[0],400)
        self.assertEqual(Client(self.port).call(url)[0],401)
        viewer,_=self.invite('viewer');self.assertEqual(viewer.call(url),(200,svg.encode()))
        uid=viewer.call('/api/session')[1]['user']['id'];self.owner.call(self.base+'/members','DELETE',{'userId':uid});self.assertEqual(viewer.call(url)[0],404)
        self.owner.call(self.base,'DELETE',{});self.assertEqual(self.owner.call(url)[0],404)


if __name__=='__main__':unittest.main()

<cfset prc.user = getUser(url.id)>
<cfoutput>
  Hello #encodeForHTML(prc.user.name)#!
</cfoutput>

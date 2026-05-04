<cfset prc.user = entityLoad("User", url.id, true)>
<cfoutput>
  #encodeForHTML(prc.user.getName())#
</cfoutput>

<cfset prc.user = userService.findById(url.id)>
<cfoutput>
  #encodeForHTML(prc.user.name)#
</cfoutput>

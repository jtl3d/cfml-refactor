<cfset userService = getInstance("UserService")>
<cfset users = userService.getActiveUsers()>
<cfoutput>
  Found #arrayLen(users)# users.
</cfoutput>
